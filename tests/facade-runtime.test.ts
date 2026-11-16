import { assert, assertEquals, assertRejects } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };
import { adminCall } from './admin-client.ts';
import { bounded, pause } from './helpers/server-process.ts';
import { ColdAuthTimings } from './helpers/cold-auth-timings.ts';
import { facadeTls } from './support/facade-tls.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { lookupAlias } from '#engine/server/aliases.ts';
import { listedRooms } from '#engine/server/directory.ts';
import { makeServer, seedServer } from './federation/doc-helper.ts';
import { fedCaller } from './http-federation.ts';
import { setConfigForTests } from '#engine/config.ts';
import { loginUser, verifyUserPassword } from '#engine/tenant/users.ts';
import { lookupToken } from '#engine/tenant/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getAccountData, putAccountData } from '#engine/tenant/accountdata.ts';
import { membershipOf } from '#engine/room/membership.ts';
import { loadNode } from '#engine/facade/identity.ts';
import { redact } from '#engine/eventid.ts';
import {
  b64decode,
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPublicKeyFromRaw,
  signJson,
  verifyJson,
} from '#engine/signing-primitives.js';
import { config } from '#engine/config.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { publicDeviceValues } from '#engine/tenant/device-operations.ts';

Deno.test('cold roles expose only granted phase-honest Matrix replica routes without facade tenant genesis or home workers', async () => {
  setConfigForTests({ server: { name: 'logical.test' } });
  const tls = await facadeTls();
  const outbound: { path: string; body: string; authorization: string }[] = [];
  const receiver = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: tls.facade.cert,
    key: tls.facade.key,
  }, async (request) => {
    outbound.push({
      path: new URL(request.url).pathname,
      body: await request.text(),
      authorization: request.headers.get('authorization') ?? '',
    });
    return Response.json({ pdus: {} });
  });
  const destination = `127.0.0.1:${receiver.addr.port}`;
  const ports = [];
  for (let i = 0; i < 5; i++) {
    const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    ports.push(probe.addr.port);
    probe.close();
  }
  const [facadePort, homePort, linkPort, federationPort, homeFederationPort] =
    ports;
  const facadeConfig = `${tls.dir}/facade.toml`;
  const homeConfig = `${tls.dir}/home.toml`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const common = (side: string, port: number, role: string) =>
    `[server]\nname="logical.test"\nrole="${role}"\nport=${port}\n[store]\ndir="${tls.dir}/${side}-store"\n[media]\nroot="${tls.dir}/${side}-media"\n[admin]\nsocket="${tls.dir}/${side}.sock"\n`;
  const link = (side: string) =>
    `[facade]\nnodeid="edge_a"\nurl="https://127.0.0.1:${linkPort}"\nlinkport=${linkPort}\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n`;
  const facadeFederation =
    `[federation]\nenabled=true\nport=${federationPort}\ncert="${tls.dir}/facade.crt"\nkey="${tls.dir}/facade.key"\ncacerts=["${tls.dir}/ca.crt"]\n`;
  await Deno.writeTextFile(
    facadeConfig,
    common('facade', facadePort, 'facade') + facadeFederation +
      link('facade'),
  );
  await Deno.writeTextFile(
    homeConfig,
    common('home', homePort, 'home') +
      `[federation]\nenabled=true\nport=${homeFederationPort}\ncert="${tls.dir}/home.crt"\nkey="${tls.dir}/home.key"\ncacerts=["${tls.dir}/ca.crt"]\n` +
      link('home') + `nodes=["edge_a"]\npairfile="${bundlefile}"\n`,
  );
  let facade: Awaited<ReturnType<typeof process>> | undefined;
  let home: Awaited<ReturnType<typeof process>> | undefined;
  const remote = await makeServer('remote.test');
  const seed = await openStore({
    dir: tls.dir + '/facade-store',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
  });
  await seedServer(await seed.server(), remote);
  await seed.close();
  try {
    facade = await process(facadeConfig, 'facade: link/local admin ready');
    const status = async () => {
      const response = await adminCall(
        tls.dir + '/facade.sock',
        'facade/status',
      );
      assertEquals(response.status, 200, JSON.stringify(response));
      return response;
    };
    assertEquals((await status()).body.result.initialized, false);
    assertEquals((await status()).body.result.matrix, false);
    await assertRejects(() =>
      Deno.connect({ hostname: '127.0.0.1', port: facadePort })
    );
    const initialized =
      (await adminCall(tls.dir + '/facade.sock', 'facade/initialize')).body
        .result;
    assertEquals(initialized.node, 'edge_a');
    assertEquals(
      (await adminCall(tls.dir + '/facade.sock', 'facade/initialize')).body
        .result,
      initialized,
    );
    assertEquals(
      await Deno.stat(tls.dir + '/facade-store/tenants').catch(() => null),
      null,
    );
    assertEquals(
      await Deno.stat(tls.dir + '/facade-media').catch(() => null),
      null,
    );
    home = await process(homeConfig, 'federation: enabled');
    await until(async () => {
      try {
        const connection = await Deno.connect({
          hostname: '127.0.0.1',
          port: homePort,
        });
        connection.close();
        return true;
      } catch (error) {
        if (!(error instanceof Deno.errors.ConnectionRefused)) throw error;
        return false;
      }
    });
    const api = async (
      path: string,
      body: unknown,
      token?: string,
      method = 'POST',
    ) => {
      const response = await fetch(
        `http://127.0.0.1:${homePort}/_matrix/client/v3/${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      return { status: response.status, body: result };
    };
    const registration = { username: 'replica', password: 'replica-password' };
    const challenge = await api('register', registration);
    const registered = await api('register', {
      ...registration,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    const token = registered.body.access_token;
    const created = await api(
      'createRoom',
      {
        name: 'Home-owned replica',
        room_alias_name: 'replica',
        visibility: 'public',
      },
      token,
    );
    assertEquals(created.status, 200);
    const roomId = created.body.room_id;
    const paired = await adminCall(tls.dir + '/home.sock', 'facade/pair', {
      node: 'edge_a',
      url: `https://127.0.0.1:${linkPort}`,
      facadePin: tls.facadePin,
      expires: Date.now() + 60000,
      bundlefile,
    });
    assertEquals(paired.status, 200);
    assertEquals(
      (await adminCall(tls.dir + '/facade.sock', 'facade/accept', {
        bundlefile,
      })).status,
      200,
    );
    await until(async () => (await status()).body.result.enrolled === true);
    await until(async () =>
      (await status()).body.result.keyRoster?.ready === true
    );
    const roster = (await status()).body.result.keyRoster;
    assert(roster.revision > 0);
    assert(roster.lastHome > 0);
    await until(async () => (await status()).body.result.matrix === true);
    const sendOutbound = async (marker: string) => {
      const result = await api(
        `sendToDevice/m.egress.test/${marker}`,
        { messages: { [`@peer:${destination}`]: { '*': { marker } } } },
        token,
        'PUT',
      );
      assertEquals(result.status, 200, JSON.stringify(result));
    };
    const observedOutbound = (marker: string) =>
      outbound.filter((entry) => entry.body.includes(`"marker":"${marker}"`));
    await sendOutbound('direct');
    await until(() => Promise.resolve(observedOutbound('direct').length === 1));
    const roomScope = async () =>
      (await status()).body.result.scopes.find((scope: { scope: string }) =>
        scope.scope === 'room:' + roomId
      );
    await until(async () => (await roomScope())?.ready === true);
    const publicScope = async () =>
      (await status()).body.result.scopes.find((scope: { scope: string }) =>
        scope.scope === 'public:@replica:logical.test'
      );
    await until(async () => (await publicScope())?.ready === true);
    await until(async () =>
      (await status()).body.result.scopes.some((
        scope: { scope: string; ready: boolean },
      ) => scope.scope === 'directory' && scope.ready)
    );
    const publicGet = (path: string) =>
      fetch(`http://127.0.0.1:${facadePort}${path}`);
    const versions = await publicGet('/_matrix/client/versions');
    assertEquals(versions.status, 200);
    assertEquals(await versions.json(), {
      versions: [],
      unstable_features: {},
    });
    const tlsClient = Deno.createHttpClient({ caCerts: tls.facade.ca });
    try {
      const secure = await fetch(
        `https://127.0.0.1:${federationPort}/_matrix/client/versions`,
        { client: tlsClient },
      );
      assertEquals(secure.status, 200);
      assertEquals(await secure.json(), {
        versions: [],
        unstable_features: {},
      });
    } finally {
      tlsClient.close();
    }
    const keyResponse = await publicGet('/_matrix/key/v2/server');
    assertEquals(keyResponse.status, 200);
    const document = await keyResponse.json();
    assertEquals(document.server_name, 'logical.test');
    assertEquals(Object.keys(document.verify_keys).length, 2);
    assert(Object.hasOwn(document.verify_keys, initialized.keyId));
    assert(
      Object.hasOwn(document.signatures['logical.test'], initialized.keyId),
    );
    const hidden = await publicGet('/_matrix/client/v3/login');
    assertEquals(hidden.status, 404);
    assertEquals((await hidden.json()).errcode, 'M_UNRECOGNIZED');
    const ingress = await fetch(
      `http://127.0.0.1:${facadePort}/_matrix/federation/v1/send/not-yet`,
      { method: 'PUT', body: '{}' },
    );
    assertEquals(ingress.status, 401);
    await ingress.body?.cancel();
    const sendPath =
      '/_matrix/federation/v1/send/retained%20transaction?cut=original';
    const sendBody = {
      origin: remote.name,
      origin_server_ts: 1,
      pdus: [],
      edus: [{
        edu_type: 'm.direct_to_device',
        content: {
          sender: '@sender:remote.test',
          type: 'm.room.encrypted',
          message_id: 'retained-message',
          messages: {
            '@replica:logical.test': { '*': { ciphertext: 'opaque' } },
          },
        },
      }, { edu_type: 'm.typing', content: {} }],
    };
    const call = fedCaller((request) => {
      const url = new URL(request.url);
      return fetch(
        new Request(
          `http://127.0.0.1:${facadePort}${url.pathname}${url.search}`,
          request,
        ),
      );
    }, remote);
    const saved = await call('PUT', sendPath, sendBody);
    assertEquals(saved, { status: 200, body: { pdus: {} } });
    assertEquals(await call('PUT', sendPath, sendBody), saved);
    const changed = await call('PUT', sendPath, { ...sendBody, edus: [] });
    assertEquals(changed.status, 400);
    assertEquals(changed.body.errcode, 'M_BAD_JSON');
    const inbox = async () =>
      (await api('sync?timeout=0', undefined, token, 'GET')).body.to_device
        ?.events ?? [];
    await until(async () => (await inbox()).length === 1);
    assertEquals(await inbox(), [{
      sender: '@sender:remote.test',
      type: 'm.room.encrypted',
      content: { ciphertext: 'opaque' },
    }]);
    const publicCut = (await publicScope()).cut;
    const beforeProfileRoomCut = (await roomScope()).cut;
    assertEquals(
      (await api(
        'profile/%40replica%3Alogical.test/displayname',
        { displayname: 'Linked profile' },
        token,
        'PUT',
      )).status,
      200,
    );
    await until(async () =>
      (await publicScope())?.cut > publicCut &&
      (await publicScope())?.ready === true
    );
    // A profile change also authors a real room membership event. Observe that
    // separate room suffix before using its next cut to wait for the message.
    await until(async () =>
      (await roomScope())?.cut > beforeProfileRoomCut &&
      (await roomScope())?.ready === true
    );
    const initialCut = (await roomScope()).cut;
    const sent = await api(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/replica-suffix`,
      { body: 'Delivered through the production link', msgtype: 'm.text' },
      token,
      'PUT',
    );
    assertEquals(sent.status, 200);
    await until(async () =>
      (await roomScope())?.cut > initialCut &&
      (await roomScope())?.ready === true
    );
    const replicatedCut = (await roomScope()).cut;
    const connection = await Deno.connect({
      hostname: '127.0.0.1',
      port: facadePort,
    });
    connection.close();
    assertEquals(
      await Deno.stat(tls.dir + '/facade-media').catch(() => null),
      null,
    );
    // Completed authority must not require the old one-time plaintext bundle.
    await Deno.remove(bundlefile);
    await Deno.writeTextFile(
      facadeConfig,
      common('facade', facadePort, 'facade') + facadeFederation +
        link('facade') + `pairfile="${bundlefile}"\n`,
    );
    await facade.stop();
    facade = undefined;
    const beforeOfflineSend = outbound.length;
    await sendOutbound('offline');
    // Drain the actual home process before asserting that no ungranted
    // standalone send escaped while the owner link was unavailable.
    await home.stop();
    home = undefined;
    assertEquals(outbound.length, beforeOfflineSend);
    facade = await process(facadeConfig, 'facade: link/local admin ready');
    home = await process(homeConfig, 'federation: enabled');
    await until(() =>
      Promise.resolve(observedOutbound('offline').length === 1)
    );
    await until(async () => {
      try {
        const connection = await Deno.connect({
          hostname: '127.0.0.1',
          port: homePort,
        });
        connection.close();
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.ConnectionRefused) return false;
        throw error;
      }
    });
    assertEquals(await call('PUT', sendPath, sendBody), saved);
    assertEquals((await inbox()).length, 1);
    assertEquals((await status()).body.result.keyId, initialized.keyId);
    assertEquals((await status()).body.result.enrolled, true);
    assertEquals((await roomScope()).cut, replicatedCut);
    assertEquals((await roomScope()).ready, true);
    assertEquals(
      (await status()).body.result.keyRoster.revision,
      roster.revision,
    );
    assert((await status()).body.result.keyRoster.lastHome >= roster.lastHome);
    await home.stop();
    await Deno.writeTextFile(
      homeConfig,
      await Deno.readTextFile(homeConfig) + '\noutbound="facade"\n',
    );
    home = await process(homeConfig, 'federation: enabled');
    await until(async () => {
      try {
        const connection = await Deno.connect({
          hostname: '127.0.0.1',
          port: homePort,
        });
        connection.close();
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.ConnectionRefused) return false;
        throw error;
      }
    });
    await sendOutbound('facade');
    await until(() => Promise.resolve(observedOutbound('facade').length === 1));
    await sendOutbound('barrier');
    await until(() =>
      Promise.resolve(observedOutbound('barrier').length === 1)
    );
    await adminCall(tls.dir + '/home.sock', 'facade/revoke', {
      id: paired.body.result.id,
    });
    await until(async () => (await status()).body.result.enrolled === false);
    const revoked = await publicGet('/_matrix/key/v2/server');
    assertEquals(revoked.status, 503);
    await revoked.body?.cancel();
    await home.stop();
    home = undefined;
    await facade.stop();
    facade = undefined;
    const disabledOwner = tls.dir + '/disabled-owner.toml';
    await Deno.writeTextFile(
      disabledOwner,
      (await Deno.readTextFile(homeConfig)).replace(
        'nodes=["edge_a"]',
        'nodes=[]',
      ),
    );
    const refusedOwner = await new Deno.Command(Deno.execPath(), {
      args: metadata.tasks.start.split(' ').slice(1),
      env: { COMMUNICO_CONFIG: disabledOwner, DENO_NO_PROMPT: '1' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(!refusedOwner.success);
    assert(
      new TextDecoder().decode(refusedOwner.stderr).includes(
        'retained destination egress ownership requires its configured link',
      ),
    );
    const store = await openStore({
      dir: tls.dir + '/facade-store',
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    });
    try {
      assertEquals(
        (await openTenant(store, 'logical.test')).keyId,
        initialized.keyId,
      );
      assertEquals(
        (await (await store.server()).query(
          'SELECT role FROM runtime_identity',
        ))[0].role,
        'facade',
      );
      const server = await store.server();
      const egress = await server.query(
        'SELECT mode,body,result_json FROM facade_egress ORDER BY txn_id',
      );
      for (const marker of ['direct', 'offline', 'facade']) {
        const matching = egress.filter((row) =>
          String(row.body).includes(`"marker":"${marker}"`)
        );
        assertEquals(
          matching.length,
          1,
          `durable destination owner for ${marker}`,
        );
        assertEquals(
          matching[0].mode,
          marker === 'facade' ? 'facade' : 'direct',
        );
        assertEquals(JSON.parse(String(matching[0].result_json)), { pdus: {} });
        assertEquals(observedOutbound(marker).length, 1);
        assert(
          observedOutbound(marker)[0].authorization.includes(
            `key="${
              marker === 'facade'
                ? initialized.keyId
                : Object.keys(document.verify_keys).find((id) =>
                  id !== initialized.keyId
                )
            }"`,
          ),
        );
      }
      const [admission] = await server.query(
        'SELECT txn_id,evidence_json,response_json FROM facade_ingress',
      );
      assertEquals(admission.txn_id, 'retained transaction');
      assertEquals(JSON.parse(String(admission.response_json)), saved);
      const proof = JSON.parse(String(admission.evidence_json));
      assertEquals(proof.origin, remote.name);
      assertEquals(proof.request.uri, sendPath);
      const [obligation] = await server.query(
        "SELECT record_json FROM facade_records WHERE stream='ingress:remote.test'",
      );
      const retained = JSON.parse(String(obligation.record_json)).payload;
      assertEquals(retained.evidence, proof);
      assertEquals(
        retained.edus.map((edu: { disposition: { kind: string } }) =>
          edu.disposition.kind
        ),
        ['retained', 'expired'],
      );
      assertEquals(
        (await server.query('SELECT * FROM federation_txns')).length,
        0,
      );
      const [drained] = await server.query(
        "SELECT result_json FROM facade_records WHERE stream='ingress:remote.test'",
      );
      assert(
        drained.result_json !== null,
        'home completion must reach facade ACK',
      );
      assertEquals(await lookupAlias(server, '#replica:logical.test'), roomId);
      assertEquals(await listedRooms(server), [roomId]);
      const [control] = await server.query(
        'SELECT roster_json,revision FROM facade_key_roster',
      );
      assertEquals(Number(control.revision), roster.revision);
      const keys = JSON.parse(String(control.roster_json)).keys;
      assertEquals(keys.length, 2);
      assert(
        keys.some((key: { keyId: string }) => key.keyId === initialized.keyId),
      );
      const [applied] = await server.query(
        "SELECT applied FROM facade_streams WHERE direction='in' AND stream='control'",
      );
      assertEquals(Number(applied.applied), 1);
      const replicaTenant = await openTenant(store, 'logical.test');
      assertEquals(
        (await replicaTenant.tx((tx) => tx.profiles.get('replica')))
          ?.displayname,
        'Linked profile',
      );
      assertEquals(
        await replicaTenant.tx((tx) => tx.credentials.hash('replica')),
        null,
      );
      const replica = await openRoom(store, roomId);
      assertEquals(
        await replica.tx(async (tx) =>
          (await tx.events.getStatus(sent.body.event_id))?.standing
        ),
        'accepted',
      );
      assert(
        await replica.tx((tx) => tx.segments.positionOf(sent.body.event_id)),
      );
      assertEquals(
        JSON.parse(
          (await replica.tx((tx) => tx.events.get(sent.body.event_id)))!.pdu,
        ).content.body,
        'Delivered through the production link',
      );
    } finally {
      await store.close();
    }
    const wrong = tls.dir + '/wrong-role.toml';
    await Deno.writeTextFile(
      wrong,
      common('facade', facadePort, 'home') + '[federation]\nenabled=false\n',
    );
    const rejected = await new Deno.Command(Deno.execPath(), {
      args: metadata.tasks.start.split(' ').slice(1),
      env: { COMMUNICO_CONFIG: wrong, DENO_NO_PROMPT: '1' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(!rejected.success);
    assert(
      new TextDecoder().decode(rejected.stderr).includes(
        'runtime role/name/node does not match store',
      ),
    );
  } finally {
    await home?.dispose();
    await facade?.dispose();
    await receiver.shutdown();
    await tls.close();
    setConfigForTests({});
  }
});

Deno.test('cold F2 link workers export account cuts and recover facade authority before home ACK', async () => {
  const tls = await facadeTls();
  const ports: number[] = [];
  for (let i = 0; i < 3; i++) {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    ports.push(listener.addr.port);
    listener.close();
  }
  const [homePort, facadePort, linkPort] = ports;
  const bundlefile = tls.dir + '/auth-bundle.json';
  const file = (side: string) => tls.dir + '/' + side + '-auth.toml';
  for (const side of ['home', 'facade']) {
    await Deno.writeTextFile(
      file(side),
      `[server]\nname="logical.test"\nrole="${side}"\nport=${
        side === 'home' ? homePort : facadePort
      }\n` +
        `[store]\ndir="${tls.dir}/${side}-auth-store"\n[media]\nroot="${tls.dir}/${side}-auth-media"\n[admin]\nsocket="${tls.dir}/${side}-auth.sock"\n[federation]\nenabled=false\n` +
        `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:${linkPort}"\nlinkport=${linkPort}\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
        (side === 'home' ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n` : ''),
    );
  }
  let home: Awaited<ReturnType<typeof process>> | undefined;
  let edge: Awaited<ReturnType<typeof process>> | undefined;
  const api = async (
    path: string,
    body?: unknown,
    token?: string,
    method = body === undefined ? 'GET' : 'POST',
    port = homePort,
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/_matrix/client/v3/${path}`,
      {
        method,
        headers: token ? { authorization: 'Bearer ' + token } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const open = (side: string) =>
    openStore({
      dir: `${tls.dir}/${side}-auth-store`,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    });
  try {
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await adminCall(tls.dir + '/facade-auth.sock', 'facade/initialize');
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('login')).status === 200;
      } catch {
        return false;
      }
    });
    const registration = { username: 'outside', password: 'offline-password' };
    const challenge = await api('register', registration);
    const registered = await api('register', {
      ...registration,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    const baselineResponse = await fetch(
      `http://127.0.0.1:${homePort}/_matrix/client/v3/user/%40outside%3Alogical.test/account_data/m.secret_storage.key`,
      {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + registered.body.access_token },
        body: JSON.stringify({ ciphertext: 'home-baseline', fraction: 0.125 }),
      },
    );
    assertEquals(baselineResponse.status, 200);
    await baselineResponse.arrayBuffer();
    const created = await api(
      'createRoom',
      { room_version: '11' },
      registered.body.access_token,
    );
    assertEquals(created.status, 200);
    const roomId = created.body.room_id;
    const roomPath = 'rooms/' + encodeURIComponent(roomId);
    const sent = await api(
      roomPath + '/send/m.room.encrypted/b3-baseline',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'receipt-baseline',
      },
      registered.body.access_token,
      'PUT',
    );
    assertEquals(sent.status, 200);
    const eventId = sent.body.event_id;
    const user = '@outside:logical.test';
    const homePair = await generateSigningKeypair() as CryptoKeyPair;
    const homePublic = b64encodeStd(
      await exportPublicKeyRaw(homePair.publicKey),
    );
    const homeDevice = registered.body.device_id;
    const homeKey = {
      user_id: user,
      device_id: homeDevice,
      algorithms: [],
      keys: { ['ed25519:' + homeDevice]: homePublic },
    };
    await signJson(homeKey, user, 'ed25519:' + homeDevice, homePair.privateKey);
    assertEquals(
      (await api(
        'keys/upload',
        { device_keys: homeKey },
        registered.body.access_token,
      )).status,
      200,
    );
    const masterPair = await generateSigningKeypair() as CryptoKeyPair;
    const masterPublic = b64encodeStd(
      await exportPublicKeyRaw(masterPair.publicKey),
    );
    const master = {
      user_id: user,
      usage: ['master'],
      keys: { ['ed25519:' + masterPublic]: masterPublic },
    };
    await signJson(master, user, 'ed25519:' + homeDevice, homePair.privateKey);
    assertEquals(
      (await api(
        'keys/device_signing/upload',
        { master_key: master },
        registered.body.access_token,
      )).status,
      200,
    );
    const paired = await adminCall(tls.dir + '/home-auth.sock', 'facade/pair', {
      node: 'edge_a',
      url: `https://127.0.0.1:${linkPort}`,
      facadePin: tls.facadePin,
      expires: Date.now() + 60000,
      bundlefile,
    });
    assertEquals(paired.status, 200);
    assertEquals(
      (await adminCall(tls.dir + '/facade-auth.sock', 'facade/accept', {
        bundlefile,
      })).status,
      200,
    );
    await until(async () => {
      const response = await adminCall(
        tls.dir + '/facade-auth.sock',
        'facade/status',
      );
      const scopes = response.body.result.scopes;
      return scopes.some((
        scope: { scope: string; ready: boolean },
      ) => scope.scope === 'auth:@outside:logical.test' && scope.ready) &&
        scopes.some((scope: { scope: string; ready: boolean }) =>
          scope.scope === 'domain:@outside:logical.test' && scope.ready
        ) && scopes.some((scope: { scope: string; ready: boolean }) =>
          scope.scope === 'room:' + roomId && scope.ready
        );
    });
    // Observe actual received/applied semantic streams, not merely the older F1
    // public snapshot. No test calls the link exporters or importers directly.
    await until(async () => {
      const state =
        (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status'))
          .body.result;
      return ['devices:', 'signing:', 'signatures:'].every((prefix) =>
        state.streams.some((stream: {
          stream: string;
          received: { sequence: number; hash: string };
          applied: { sequence: number; hash: string };
        }) =>
          stream.stream === prefix + user && stream.applied.sequence > 0 &&
          stream.received.sequence === stream.applied.sequence &&
          stream.received.hash === stream.applied.hash
        )
      );
    });
    await home.stop();
    await edge.stop();
    const offline = await open('facade');
    let token: string;
    const edgePair = await generateSigningKeypair() as CryptoKeyPair;
    const edgePublic = b64encodeStd(
      await exportPublicKeyRaw(edgePair.publicKey),
    );
    const signedByEdge = structuredClone(master);
    await signJson(
      signedByEdge,
      user,
      'ed25519:outside-device',
      edgePair.privateKey,
    );
    try {
      const tenant = await openTenant(offline, 'logical.test');
      assertEquals(
        (await (await offline.tenant('logical.test')).tx((conn) =>
          publicDeviceValues(conn, 'outside')
        )).find((op) => op.deviceId === homeDevice)
          ?.value?.keys,
        homeKey,
      );
      // The owner view, unlike F1's snapshot reader, includes the held identity
      // and its exact original pre-enrollment device-signature basis.
      const heldMaster = await tenant.tx((tx) =>
        tx.crossSigning.state('outside')
      );
      assertEquals(JSON.parse(heldMaster.master!.json), master);
      assertEquals(
        await getAccountData(tenant, 'outside', '', 'm.secret_storage.key'),
        { ciphertext: 'home-baseline', fraction: 0.125 },
      );
      await putAccountData(tenant, 'outside', '', 'm.secret_storage.key', {
        ciphertext: 'edge-recovered',
      });
      assertEquals(
        await verifyUserPassword(tenant, 'outside', 'offline-password'),
        true,
      );
      const session = await loginUser(tenant, {
        localpart: 'outside',
        password: 'offline-password',
        deviceId: 'outside-device',
        refresh: true,
      });
      token = session.accessToken;
      const edgeKey = {
        user_id: user,
        device_id: 'outside-device',
        algorithms: [],
        keys: { 'ed25519:outside-device': edgePublic },
      };
      await signJson(
        edgeKey,
        user,
        'ed25519:outside-device',
        edgePair.privateKey,
      );
      const device = await deviceIdentity(tenant, 'outside', 'outside-device');
      await tenant.tx((tx) =>
        tx.e2ee.upload(
          device,
          validateUpload(
            { device_keys: edgeKey },
            user,
            device.deviceId,
            config().e2ee,
          ),
        )
      );
      assertEquals(
        await tenant.tx((tx) =>
          tx.keySignatures.upload('outside', user, [{
            user,
            id: masterPublic,
            json: signedByEdge,
          }])
        ),
        { failures: {} },
      );
    } finally {
      await offline.close();
    }
    // The mutation happened while both processes were absent. Restart scans
    // durable owner state; an in-memory notification cannot supply this proof.
    edge = await process(file('facade'), 'facade: link/local admin ready');
    const edgeApi = (path: string, body?: unknown, method?: string) =>
      api(path, body, token, method, facadePort);
    const accountPath =
      'user/%40outside%3Alogical.test/account_data/m.secret_storage.key';
    const userRoomPath = 'user/%40outside%3Alogical.test/rooms/' +
      encodeURIComponent(roomId);
    // Home is absent, federation is disabled, and this is the ordinary public
    // listener, not an in-process tenant call or the local-admin adapter.
    await until(async () => {
      const state =
        (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status')).body
          .result;
      return ['domain:@outside:logical.test', 'room:' + roomId].every(
        (scope) => {
          const held = state.scopes.find((row: { scope: string }) =>
            row.scope === scope
          );
          const stream = state.streams.find((row: { stream: string }) =>
            row.stream === scope
          );
          return held?.ready && held.pending === null && stream &&
            stream.received.sequence === stream.applied.sequence;
        },
      );
    });
    assertEquals(await edgeApi(accountPath), {
      status: 200,
      body: { ciphertext: 'edge-recovered' },
    });
    assertEquals(
      (await edgeApi(accountPath, { ciphertext: 'edge-public' }, 'PUT')).status,
      200,
    );
    assertEquals(
      (await edgeApi(
        userRoomPath + '/account_data/m.test',
        { value: 'room' },
        'PUT',
      )).status,
      200,
    );
    assertEquals((await edgeApi(userRoomPath + '/account_data/m.test')).body, {
      value: 'room',
    });
    assertEquals(
      (await edgeApi(
        userRoomPath + '/tags/m.favourite',
        { order: 0.25 },
        'PUT',
      )).status,
      200,
    );
    assertEquals((await edgeApi(userRoomPath + '/tags')).body, {
      tags: { 'm.favourite': { order: 0.25 } },
    });
    assertEquals(
      (await edgeApi('profile/%40outside%3Alogical.test/org.test.field', {
        'org.test.field': 'offline',
      }, 'PUT')).status,
      200,
    );
    assertEquals(
      (await edgeApi('profile/%40outside%3Alogical.test'))
        .body['org.test.field'],
      'offline',
    );
    const rulePath = 'pushrules/global/override/offline-rule';
    assertEquals(
      (await edgeApi(
        rulePath,
        { actions: ['dont_notify'], conditions: [] },
        'PUT',
      )).status,
      200,
    );
    assertEquals(
      (await edgeApi(rulePath + '/enabled', { enabled: false }, 'PUT')).status,
      200,
    );
    assertEquals((await edgeApi(rulePath + '/enabled')).body, {
      enabled: false,
    });
    assertEquals(
      (await edgeApi('pushrules/')).body.global.override.some((
        rule: { rule_id: string },
      ) => rule.rule_id === 'offline-rule'),
      true,
    );
    for (const type of ['m.read', 'm.read.private']) {
      assertEquals(
        (await edgeApi(
          roomPath + '/receipt/' + type + '/' + encodeURIComponent(eventId),
          {},
        )).status,
        200,
      );
    }
    assertEquals(
      (await edgeApi(roomPath + '/read_markers', { 'm.fully_read': eventId }))
        .status,
      200,
    );
    assertEquals(
      (await edgeApi(userRoomPath + '/account_data/m.fully_read')).body,
      { event_id: eventId },
    );
    assertEquals(
      (await edgeApi(
        'profile/%40outside%3Alogical.test/org.test.field',
        undefined,
        'DELETE',
      )).status,
      200,
    );
    assertEquals(
      (await edgeApi('profile/%40outside%3Alogical.test/org.test.field'))
        .status,
      404,
    );
    assertEquals(
      (await edgeApi(userRoomPath + '/tags/m.favourite', undefined, 'DELETE'))
        .status,
      200,
    );
    assertEquals((await edgeApi(rulePath, undefined, 'DELETE')).status, 200);
    assertEquals(
      (await edgeApi(
        'rooms/!unknown:logical.test/receipt/m.read/%24unknown',
        {},
      )).status,
      403,
    );
    assertEquals(
      (await edgeApi('rooms/!unknown:logical.test/read_markers', {
        'm.fully_read': '$unknown',
      })).status,
      404,
    );
    // A held but incomplete scope must refuse before receipt/account effects.
    // Change only persisted readiness while its owning process is stopped.
    for (const scope of ['room:' + roomId, 'domain:@outside:logical.test']) {
      await edge.stop();
      const held = await open('facade');
      const server = await held.server();
      const before = await server.query(
        "SELECT operation_id FROM domain_operations WHERE kind='receipt' ORDER BY operation_id",
      );
      await server.execute('UPDATE facade_scopes SET ready=0 WHERE scope=?', [
        scope,
      ]);
      await held.close();
      edge = await process(file('facade'), 'facade: link/local admin ready');
      for (
        const [path, body] of [
          [roomPath + '/receipt/m.read/%24not-admitted', {}],
          [roomPath + '/receipt/m.read.private/%24not-admitted', {
            thread_id: 'main',
          }],
          [roomPath + '/read_markers', { 'm.fully_read': eventId }],
        ] as const
      ) assertEquals((await edgeApi(path, body)).status, 503);
      if (scope.startsWith('domain:')) {
        for (
          const path of [
            accountPath,
            userRoomPath + '/tags',
            'pushrules/',
            'profile/%40outside%3Alogical.test',
          ]
        ) {
          assertEquals((await edgeApi(path)).status, 503);
        }
      }
      await edge.stop();
      const after = await open('facade');
      const afterServer = await after.server();
      assertEquals(
        await afterServer.query(
          "SELECT operation_id FROM domain_operations WHERE kind='receipt' ORDER BY operation_id",
        ),
        before,
      );
      await afterServer.execute(
        'UPDATE facade_scopes SET ready=1 WHERE scope=?',
        [scope],
      );
      await after.close();
      edge = await process(file('facade'), 'facade: link/local admin ready');
    }
    assertEquals((await edgeApi(accountPath)).body, {
      ciphertext: 'edge-public',
    });
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        const value = await api(
          'user/%40outside%3Alogical.test/account_data/m.secret_storage.key',
          undefined,
          registered.body.access_token,
        );
        return value.status === 200 &&
          value.body.ciphertext === 'edge-public';
      } catch {
        return false;
      }
    });
    await until(async () => {
      try {
        return (await api('account/whoami', undefined, token)).status === 503;
      } catch {
        return false;
      }
    });
    // A normal home Matrix consumer observes the cold-recovered facade overlay.
    // Its device basis requires the independent authority and device streams;
    // stream startup or a stored unverified signature alone cannot satisfy this.
    await until(async () => {
      const query = await api(
        'keys/query',
        { device_keys: { [user]: [] } },
        registered.body.access_token,
      );
      return query.status === 200 && query.body.master_keys?.[user]
            ?.signatures?.[user]?.['ed25519:outside-device'] ===
          (signedByEdge as typeof signedByEdge & {
            signatures: Record<string, Record<string, string>>;
          }).signatures[user]['ed25519:outside-device'];
    });
    const before =
      (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status')).body
        .result.scopes.find((scope: { scope: string }) =>
          scope.scope === 'auth:@outside:logical.test'
        ).cut;
    assertEquals(
      (await api('logout/all', {}, registered.body.access_token)).status,
      200,
    );
    await until(async () => {
      const response = await adminCall(
        tls.dir + '/facade-auth.sock',
        'facade/status',
      );
      // One capture may already be in flight at logout; its successor is taken
      // after that mutation by the account's serialized export owner.
      return response.body.result.scopes.some((
        scope: { scope: string; ready: boolean; cut: number },
      ) =>
        scope.scope === 'auth:@outside:logical.test' && scope.ready &&
        scope.cut > before + 1
      );
    });
    // Captures already queued before logout can advance a numeric cut too.
    // Observe revocation at the actual authenticated consumer before closing.
    await until(async () => {
      const response = await fetch(
        `http://127.0.0.1:${facadePort}/_matrix/client/v3/account/whoami`,
        { headers: { authorization: 'Bearer ' + token } },
      );
      const body = await response.json();
      return response.status === 401 && body.errcode === 'M_UNKNOWN_TOKEN';
    });
    await home.stop();
    await edge.stop();
    const closedHome = await open('home'), closedEdge = await open('facade');
    try {
      const [received] = await (await closedHome.server()).query(
        "SELECT received,applied FROM facade_streams WHERE direction='in' AND stream='authority:@outside:logical.test'",
      );
      assert(Number(received.applied) > 0);
      const [ack] = await (await closedEdge.server()).query(
        "SELECT result_json FROM facade_records WHERE direction='out' AND stream='authority:@outside:logical.test' AND result_json IS NOT NULL LIMIT 1",
      );
      assert(ack);
      const tenant = await openTenant(closedEdge, 'logical.test');
      await assertRejects(
        () => lookupToken(tenant, token),
        MatrixError,
        'session authority revoked',
      );
    } finally {
      await closedHome.close();
      await closedEdge.close();
    }
  } finally {
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});

Deno.test('cold F2 public auth uses held authority offline and refuses strict or verifier-off work before effects', async () => {
  const timings = new ColdAuthTimings();
  timings.phase('configure and enroll');
  const tls = await facadeTls();
  const ports: number[] = [];
  for (let i = 0; i < 3; i++) {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    ports.push(listener.addr.port);
    listener.close();
  }
  const [homePort, facadePort, linkPort] = ports;
  const bundlefile = tls.dir + '/public-auth-bundle.json';
  const file = (side: string) => tls.dir + '/' + side + '-public-auth.toml';
  const configure = async (side: string, extra = '') => {
    await Deno.writeTextFile(
      file(side),
      `[server]\nname="logical.test"\nrole="${side}"\nport=${
        side === 'home' ? homePort : facadePort
      }\n` +
        `[store]\ndir="${tls.dir}/${side}-public-auth-store"\n[media]\nroot="${tls.dir}/${side}-public-auth-media"\n[admin]\nsocket="${tls.dir}/${side}-public-auth.sock"\n[federation]\nenabled=false\n` +
        `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:${linkPort}"\nlinkport=${linkPort}\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
        (side === 'home'
          ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n`
          : '') +
        extra,
    );
  };
  await configure('home');
  await configure('facade');
  let home: Awaited<ReturnType<typeof process>> | undefined;
  let edge: Awaited<ReturnType<typeof process>> | undefined;
  const api = async (
    side: 'home' | 'facade',
    path: string,
    body?: unknown,
    token?: string,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    return await timings.request(side + ' ' + method + ' ' + path, async () => {
      const response = await fetch(
        `http://127.0.0.1:${
          side === 'home' ? homePort : facadePort
        }/_matrix/client/v3/${path}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: 'Bearer ' + token } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return { status: response.status, body: await response.json() };
    });
  };
  const login = (device = 'public-device', password = 'offline-password') => ({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: 'outside' },
    password,
    device_id: device,
    refresh_token: true,
  });
  const authTail = async (localparts: string[]) => {
    // Permissive auth may use a complete older cut. Observe the journal through
    // its owning process instead; home is stopped so its received tail is finite.
    // Never open a second store while the child owns its lock.
    await until(async () => {
      const status =
        (await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/status'))
          .body.result;
      return localparts.every((localpart) => {
        const scope = 'auth:@' + localpart + ':logical.test';
        const held = status.scopes.find((row: { scope: string }) =>
          row.scope === scope
        );
        const stream = status.streams.find((row: { stream: string }) =>
          row.stream === scope
        );
        return held?.ready && held.pending === null && stream &&
          stream.received.sequence === stream.applied.sequence &&
          stream.received.hash === stream.applied.hash;
      });
    });
  };
  try {
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/initialize');
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('home', 'login')).status === 200;
      } catch {
        return false;
      }
    });
    const registration = {
      username: 'outside',
      password: 'offline-password',
      device_id: 'home-device',
    };
    const challenge = await api('home', 'register', registration);
    const registered = await api('home', 'register', {
      ...registration,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    const departureRegistration = {
      username: 'departure',
      password: 'offline-password',
      device_id: 'departure-home-device',
    };
    const departureChallenge = await api(
      'home',
      'register',
      departureRegistration,
    );
    const departure = await api('home', 'register', {
      ...departureRegistration,
      auth: { type: 'm.login.dummy', session: departureChallenge.body.session },
    });
    assertEquals(departure.status, 200);
    const departureRoom = await api('home', 'createRoom', {
      preset: 'public_chat',
      room_version: '11',
    }, departure.body.access_token);
    assertEquals(departureRoom.status, 200);
    assertEquals(
      (await adminCall(tls.dir + '/home-public-auth.sock', 'facade/pair', {
        node: 'edge_a',
        url: `https://127.0.0.1:${linkPort}`,
        facadePin: tls.facadePin,
        expires: Date.now() + 60000,
        bundlefile,
      })).status,
      200,
    );
    assertEquals(
      (await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/accept', {
        bundlefile,
      })).status,
      200,
    );
    await until(async () => {
      const scopes =
        (await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/status'))
          .body.result.scopes;
      return [
        'auth:@outside:logical.test',
        'auth:@departure:logical.test',
        'room:' + departureRoom.body.room_id,
      ].every((required) =>
        scopes.some((scope: { scope: string; ready: boolean }) =>
          scope.scope === required && scope.ready
        )
      );
    });
    await home.stop();
    // Shutdown stops between records; it does not drain the received tail.
    // With home stopped, restart and observe the actual finite auth apply cut
    // before proving cold offline login from durable authority.
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await authTail(['outside', 'departure']);
    assertEquals((await api('facade', 'login')).body, {
      flows: [{ type: 'm.login.password' }],
    });
    const session = await api('facade', 'login', login());
    assertEquals(session.status, 200, JSON.stringify(session));
    assertEquals(session.body.device_id, 'public-device');
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        session.body.access_token,
      )).body.user_id,
      '@outside:logical.test',
    );
    assertEquals(
      (await api('facade', 'login', login('bad-device', 'wrong'))).status,
      403,
    );
    const foreign = await api('facade', 'login', login('home-device'));
    assertEquals(foreign, {
      status: 503,
      body: {
        errcode: 'M_UNAVAILABLE',
        error: 'operation owner unavailable at this ingress',
      },
    });
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        registered.body.access_token,
      )).status,
      503,
    );
    assertEquals(
      (await api('facade', 'account/whoami', undefined, 'unknown')).status,
      401,
    );
    const rotated = await api('facade', 'refresh', {
      refresh_token: session.body.refresh_token,
    });
    assertEquals(rotated.status, 200);
    await edge.stop();
    await configure('facade', 'allowstaleauth=false\n');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    const unavailable = {
      status: 503,
      body: {
        errcode: 'M_UNAVAILABLE',
        error: 'authentication snapshot unavailable',
      },
    };
    assertEquals(
      await api(
        'facade',
        'account/whoami',
        undefined,
        rotated.body.access_token,
      ),
      unavailable,
    );
    assertEquals(
      await api('facade', 'refresh', {
        refresh_token: session.body.refresh_token,
      }),
      unavailable,
    );
    assertEquals(
      await api('facade', 'login', login('strict-device')),
      unavailable,
    );
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('home', 'login')).status === 200;
      } catch {
        return false;
      }
    });
    await until(async () =>
      (await api(
        'facade',
        'login',
        login('online-strict-device'),
      )).status === 200
    );
    await home.stop();
    await until(async () =>
      (await api(
        'facade',
        'login',
        login('offline-strict-probe', 'not-the-password'),
      )).status === 503
    );
    assertEquals(
      await api('facade', 'login', login('offline-strict-device')),
      unavailable,
    );
    await edge.stop();
    await configure('facade');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    // The online strict login may have left another finite auth suffix. As at
    // the first cold restart, listener readiness is not owner apply completion.
    await authTail(['outside', 'departure']);
    // Refused GETs and refreshes above must not close the original retry window.
    const retried = await api('facade', 'refresh', {
      refresh_token: session.body.refresh_token,
    });
    assertEquals(retried.status, 200, JSON.stringify(retried));
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        rotated.body.access_token,
      )).status,
      401,
    );
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        retried.body.access_token,
      )).status,
      200,
    );
    assertEquals(
      (await api('facade', 'refresh', {
        refresh_token: session.body.refresh_token,
      })).status,
      401,
    );
    const target = await api('facade', 'login', login('delete-target'));
    assertEquals(target.status, 200);
    const deletion = await api('facade', 'delete_devices', {
      devices: ['delete-target'],
    }, retried.body.access_token);
    assertEquals(deletion.status, 401);
    assertEquals(
      (await api('facade', 'delete_devices', {
        devices: ['delete-target'],
        auth: {
          type: 'm.login.password',
          session: deletion.body.session,
          password: 'offline-password',
        },
      }, retried.body.access_token)).status,
      200,
    );
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        target.body.access_token,
      )).status,
      401,
    );
    await edge.stop();
    await configure('facade', 'replicatecredentials=false\n');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    assertEquals((await api('facade', 'login')).body, { flows: [] });
    assertEquals(
      await api('facade', 'login', login('disabled-device')),
      unavailable,
    );
    assertEquals(
      await api(
        'facade',
        'delete_devices',
        { devices: ['public-device'] },
        retried.body.access_token,
      ),
      unavailable,
    );
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        retried.body.access_token,
      )).status,
      200,
    );
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('home', 'login')).status === 200;
      } catch {
        return false;
      }
    });
    assertEquals(
      await api('facade', 'login', login('still-disabled')),
      unavailable,
    );
    assertEquals((await api('facade', 'register', {})).status, 503);
    assertEquals(
      (await api('facade', 'createRoom', {}, retried.body.access_token)).status,
      404,
    );
    await edge.stop();
    await configure('facade');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    // Home controls verifier export independently of the facade's local setting.
    await home.stop();
    await configure('home', 'replicatecredentials=false\n');
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('home', 'login')).status === 200;
      } catch {
        return false;
      }
    });
    // Observe capability withdrawal without issuing new sessions while waiting.
    // A successful login is a mutation and feeds the account replication loop.
    await until(async () =>
      (await api('facade', 'login')).body.flows.length === 0
    );
    assertEquals(
      await api('facade', 'login', login('home-kept-verifier')),
      unavailable,
    );
    await home.stop();
    await until(async () =>
      (await api(
          'facade',
          'account/whoami',
          undefined,
          retried.body.access_token,
        )).status === 200 &&
      (await api('facade', 'login')).body.flows.length === 0
    );
    assertEquals(
      await api('facade', 'login', login('home-kept-verifier')),
      unavailable,
    );
    assertEquals((await api('facade', 'login')).body, { flows: [] });
    await configure('home');
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('home', 'login')).status === 200;
      } catch {
        return false;
      }
    });
    await until(async () =>
      (await api('facade', 'login', login('verifier-restored'))).status === 200
    );
    await home.stop();
    await until(async () =>
      (await api(
        'facade',
        'account/whoami',
        undefined,
        retried.body.access_token,
      )).status === 200
    );
    const crossDelete = await api(
      'facade',
      'devices/home-device',
      {
        auth: { type: 'm.login.password', password: 'offline-password' },
      },
      retried.body.access_token,
      'DELETE',
    );
    assertEquals(crossDelete.status, 200, JSON.stringify(crossDelete));
    home = await process(file('home'), 'federation: disabled');
    await until(async () => {
      try {
        return (await api('home', 'login')).status === 200;
      } catch {
        return false;
      }
    });
    await until(async () =>
      (await api(
        'home',
        'account/whoami',
        undefined,
        registered.body.access_token,
      )).status === 401
    );
    timings.phase('home deactivation login');
    const homeLogin = await api('home', 'login', login('later-home-device'));
    assertEquals(homeLogin.status, 200);
    timings.phase('home deactivation HTTP commit');
    assertEquals(
      (await api('home', 'account/deactivate', {
        auth: { type: 'm.login.password', password: 'offline-password' },
      }, homeLogin.body.access_token)).status,
      200,
    );
    timings.phase('facade observes home deactivation');
    await until(async () =>
      (await api(
        'facade',
        'login',
        login('after-deactivation'),
      )).body
        .errcode === 'M_FORBIDDEN'
    );
    timings.phase('home deactivation shutdown');
    await home.stop();
    // Home shutdown can finish after another capture was received but before
    // its independent facade owner commits the apply/result. Drain that cut.
    timings.phase('facade drains deactivation tail offline');
    await until(async () =>
      (await api(
        'facade',
        'login',
        login('offline-deactivated', 'not-the-password'),
      )).body
        .errcode ===
        'M_FORBIDDEN'
    );
    assertEquals(
      (await api('facade', 'login', login('offline-deactivated'))).body.errcode,
      'M_FORBIDDEN',
    );
    // A different served account deactivates at the facade with home absent.
    // Its worker must sign the actual replicated-room leave, not only revoke
    // tokens or retain a tenant root. UIA is exercised over public HTTP.
    const departureLogin = {
      ...login('departure-edge-device'),
      identifier: { type: 'm.id.user', user: 'departure' },
    };
    // Restart does not itself prove the finite received tail has been applied.
    timings.phase('departure facade restart');
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    timings.phase('departure auth tail');
    await authTail(['departure']);
    // The preceding verifier-withdrawal/restoration exercise covers every
    // served account asynchronously. Observe this account's restored verifier
    // without minting a new session while its last received cut drains.
    await until(async () =>
      (await api('facade', 'login', {
        ...departureLogin,
        password: 'not-the-password',
      })).status === 403
    );
    timings.phase('departure login and UIA');
    const departureSession = await api('facade', 'login', departureLogin);
    assertEquals(
      departureSession.status,
      200,
      JSON.stringify(departureSession),
    );
    const departureUia = await api('facade', 'account/deactivate', {
      erase: true,
    }, departureSession.body.access_token);
    assertEquals(departureUia.status, 401, JSON.stringify(departureUia));
    assertEquals(
      (await api('facade', 'account/deactivate', {
        erase: true,
        auth: {
          type: 'm.login.password',
          session: departureUia.body.session,
          password: 'offline-password',
        },
      }, departureSession.body.access_token)).status,
      200,
    );
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        departureSession.body.access_token,
      )).status,
      401,
    );
    timings.phase('departure leave commit and facade shutdown');
    await edge.stop();
    const closed = await openStore({
      dir: tls.dir + '/facade-public-auth-store',
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
    });
    let leaveId: string;
    try {
      const room = await openRoom(closed, departureRoom.body.room_id);
      const member = await membershipOf(room, '@departure:logical.test');
      assertEquals(member?.membership, 'leave');
      leaveId = member!.eventId;
      const event = await room.tx((tx) => tx.events.get(leaveId));
      assert(event);
      const pdu = JSON.parse(event.pdu);
      assertEquals(pdu.content, { membership: 'leave' });
      assert(
        Object.keys(pdu.signatures['logical.test']).some((id) =>
          id.startsWith('ed25519:edge_a_')
        ),
      );
      const identity = await loadNode(
        await closed.server(),
        'logical.test',
        'edge_a',
      );
      const signed = redact(pdu, '11');
      delete signed.event_id;
      assert(
        await verifyJson(
          signed,
          'logical.test',
          identity.keyId,
          await importPublicKeyFromRaw(b64decode(identity.publicKey)),
        ),
      );
      const forged = {
        ...signed,
        signatures: { 'logical.test': { [identity.keyId]: 'A'.repeat(86) } },
      };
      assertEquals(
        await verifyJson(
          forged,
          'logical.test',
          identity.keyId,
          await importPublicKeyFromRaw(b64decode(identity.publicKey)),
        ),
        false,
      );
      assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
    } finally {
      await closed.close();
    }
    timings.phase('departure cold facade refusal');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    assertEquals(
      (await api('facade', 'login', departureLogin)).body.errcode,
      'M_FORBIDDEN',
    );
    timings.phase('departure home restart');
    home = await process(file('home'), 'federation: disabled');
    timings.phase('home observes facade deactivation');
    await until(async () => {
      try {
        return (await api('home', 'login', departureLogin)).body.errcode ===
          'M_FORBIDDEN';
      } catch {
        return false;
      }
    });
  } catch (error) {
    const owners = await Promise.all(['home', 'facade'].map(async (side) => {
      try {
        const status = (await adminCall(
          tls.dir + '/' + side + '-public-auth.sock',
          'facade/status',
        )).body.result;
        return { side, scopes: status.scopes, streams: status.streams };
      } catch {
        return { side, unavailable: true };
      }
    }));
    console.error(
      'cold auth phase diagnostics',
      JSON.stringify({
        phases: timings.snapshot(),
        owners,
      }),
    );
    throw error;
  } finally {
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});

async function until(probe: () => Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!await probe()) {
    assert(Date.now() < deadline, 'runtime observation deadline');
    await pause(10);
  }
}

async function process(config: string, ready: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: metadata.tasks.start.split(' ').slice(1),
    env: { COMMUNICO_CONFIG: config, DENO_NO_PROMPT: '1' },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let out = '', err = '', ended = false;
  const read = async (
    body: ReadableStream<Uint8Array>,
    save: (text: string) => void,
  ) => {
    for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
      save(chunk);
    }
  };
  const output = Promise.all([
    child.status,
    read(child.stdout, (text) => out += text),
    read(child.stderr, (text) => err += text),
  ]).then(([status]) => {
    ended = true;
    return status;
  });
  const dispose = async () => {
    if (!ended) {
      child.kill('SIGKILL');
      await bounded(output);
    }
  };
  try {
    await until(async () => {
      assert(!ended, out + '\n' + err);
      return await Promise.resolve(out.includes(ready));
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    async stop() {
      if (!ended) child.kill('SIGTERM');
      const status = await bounded(output);
      assertEquals(status.code, 0, out + '\n' + err);
      assert(out.includes('shutdown: store closed'));
    },
    dispose,
  };
}
