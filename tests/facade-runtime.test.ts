import { assert, assertEquals, assertRejects } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };
import { adminCall } from './admin-client.ts';
import {
  facadeProcess as process,
  observeLiveInput,
} from './helpers/facade-process.ts';
import { type LinkRecord, object } from '#engine/facade/protocol.ts';
import type { AccountAuth } from '#engine/tenant/account-auth.ts';
import type { DeviceOperation } from '#engine/tenant/device-source.ts';
import type { SigningOperation } from '#engine/tenant/signing-operations.ts';
import type { SignatureOperation } from '#engine/tenant/signature-operations.ts';
import type { ToDeviceOperation } from '#engine/tenant/todevice-routing.ts';
import type { ReplicaRoom } from '#engine/room/replica-export.ts';
import { ColdAuthTimings } from './helpers/cold-auth-timings.ts';
import { facadeTls } from './support/facade-tls.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { lookupAlias } from '#engine/server/aliases.ts';
import { listedRooms, visibility } from '#engine/server/directory.ts';
import { makeServer, seedServer } from './federation/doc-helper.ts';
import { fedCaller } from './http-federation.ts';
import { setConfigForTests } from '#engine/config.ts';
import { loginUser, verifyUserPassword } from '#engine/tenant/users.ts';
import { hashToken, lookupToken } from '#engine/tenant/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  formatPosition,
  parsePosition,
  parseStreamToken,
} from '#engine/client/tokens.ts';
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
import { FacadeKeys } from '#engine/facade/control.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { completeAccepted } from './complete-accepted.ts';

Deno.test('cold roles expose only granted phase-honest Matrix replica routes without facade tenant genesis or home workers', async () => {
  setConfigForTests({ server: { name: 'logical.test' } });
  const tls = await facadeTls();
  const outbound: { path: string; body: string; authorization: string }[] = [];
  const waitOutbound = async (marker: string) => {
    assert(home);
    await home.observations.wait((event) =>
      event.kind === 'egress' &&
      event.destination === destination &&
      event.body.includes(`"marker":"${marker}"`)
    );
  };
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
    await home.listening(homePort);
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
    const pairing = paired.body.result.id;
    await facade.observations.wait((event) =>
      event.kind === 'pairing' && event.id === pairing &&
      event.state === 'paired'
    );
    assertEquals((await status()).body.result.enrolled, true);
    await homeFact(
      facade,
      pairing,
      'control',
      (record) => object(record.payload).kind === 'key-roster',
    );
    assertEquals((await status()).body.result.keyRoster.ready, true);
    const roster = (await status()).body.result.keyRoster;
    assert(roster.revision > 0);
    assert(roster.lastHome > 0);
    await facade.listening(facadePort);
    assertEquals((await status()).body.result.matrix, true);
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
    await waitOutbound('direct');
    assertEquals(observedOutbound('direct').length, 1);
    const roomScope = async () =>
      (await status()).body.result.scopes.find((scope: { scope: string }) =>
        scope.scope === 'room:' + roomId
      );
    await homeFact(
      facade,
      pairing,
      'room:' + roomId,
      (record) => roomView(record).roomId === roomId,
    );
    assertEquals((await roomScope()).ready, true);
    const publicScope = async () =>
      (await status()).body.result.scopes.find((scope: { scope: string }) =>
        scope.scope === 'public:@replica:logical.test'
      );
    await homeFact(
      facade,
      pairing,
      'public:@replica:logical.test',
      (record) =>
        object(object(record.payload).view).userId === '@replica:logical.test',
    );
    assertEquals((await publicScope()).ready, true);
    await homeFact(
      facade,
      pairing,
      'directory',
      (record) => object(record.payload).kind === 'directory-replica',
    );
    assert(
      (await status()).body.result.scopes.some((
        scope: { scope: string; ready: boolean },
      ) => scope.scope === 'directory' && scope.ready),
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
    const facadeIncarnation = (await status()).body.result.incarnation;
    await home.observations.fact(
      {
        peer: 'edge_a',
        source: 'edge_a',
        incarnation: facadeIncarnation,
        stream: 'ingress:remote.test',
      },
      (record) => object(object(record.payload).evidence).request !== undefined,
    );
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
    await homeFact(
      facade,
      pairing,
      'public:@replica:logical.test',
      (record) =>
        object(object(object(record.payload).view).profile).displayname ===
          'Linked profile',
    );
    assert(
      (await publicScope()).cut > publicCut && (await publicScope()).ready,
    );
    // A profile change also authors a real room membership event. Observe that
    // separate room suffix before using its next cut to wait for the message.
    await homeFact(
      facade,
      pairing,
      'room:' + roomId,
      (record) =>
        roomView(record).events.some((event) =>
          event.type === 'm.room.member' &&
          event.state_key === '@replica:logical.test' &&
          event.content.displayname === 'Linked profile'
        ),
    );
    assert(
      (await roomScope()).cut > beforeProfileRoomCut &&
        (await roomScope()).ready,
    );
    const initialCut = (await roomScope()).cut;
    const sent = await api(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/replica-suffix`,
      { body: 'Delivered through the production link', msgtype: 'm.text' },
      token,
      'PUT',
    );
    assertEquals(sent.status, 200);
    await homeFact(
      facade,
      pairing,
      'room:' + roomId,
      (record) =>
        roomView(record).steps.some((step) =>
          step.eventId === sent.body.event_id
        ),
    );
    assert((await roomScope()).cut > initialCut && (await roomScope()).ready);
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
    await waitOutbound('offline');
    assertEquals(observedOutbound('offline').length, 1);
    await home.listening(homePort);
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
    await home.listening(homePort);
    await sendOutbound('facade');
    await waitOutbound('facade');
    assertEquals(observedOutbound('facade').length, 1);
    await sendOutbound('barrier');
    await waitOutbound('barrier');
    assertEquals(observedOutbound('barrier').length, 1);
    await adminCall(tls.dir + '/home.sock', 'facade/revoke', {
      id: paired.body.result.id,
    });
    await facade.observations.wait((event) =>
      event.kind === 'pairing' && event.id === pairing &&
      event.state === 'revoked'
    );
    assertEquals((await status()).body.result.enrolled, false);
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
    version = 'v3',
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/_matrix/client/${version}/${path}`,
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
    await home.listening(homePort);
    assertEquals((await api('login')).status, 200);
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
    const filterPath = 'user/%40outside%3Alogical.test/filter';
    const homeFilterBody = { room: { timeline: { limit: 7 } } };
    const homeFilter = await api(
      filterPath,
      homeFilterBody,
      registered.body.access_token,
    );
    assertEquals(homeFilter.status, 200);
    const openIdPath = 'user/%40outside%3Alogical.test/openid/request_token';
    const homeOpenId = await api(openIdPath, {}, registered.body.access_token);
    assertEquals(homeOpenId.status, 200);
    const backupMetadata = {
      algorithm: 'opaque',
      auth_data: { public_key: 'home-backup-key' },
    };
    const backupSession = {
      first_message_index: 3,
      forwarded_count: 0,
      is_verified: true,
      session_data: { ciphertext: 'retained-home-ciphertext' },
    };
    const homeBackup = await api(
      'room_keys/version',
      backupMetadata,
      registered.body.access_token,
    );
    assertEquals(homeBackup.status, 200);
    const backupVersion = homeBackup.body.version;
    assertEquals(
      (await api(
        'room_keys/keys/!backup%3Alogical.test/session?version=' +
          backupVersion,
        backupSession,
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    const openIdInfo = async (token?: string) => {
      const response = await fetch(
        `http://127.0.0.1:${facadePort}/_matrix/federation/v1/openid/userinfo`,
        {
          headers: token === undefined
            ? {}
            : { authorization: 'Bearer ' + token },
        },
      );
      return { status: response.status, body: await response.json() };
    };
    const created = await api(
      'createRoom',
      {
        room_version: '11',
        room_alias_name: 'upgrade-home-boundary',
        visibility: 'public',
      },
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
    const pairing = paired.body.result.id;
    await homeFact(
      edge,
      pairing,
      'auth:@outside:logical.test',
      (record) =>
        authView(record).localpart === 'outside' &&
        authView(record).credentials,
    );
    await homeFact(
      edge,
      pairing,
      'domain:@outside:logical.test',
      (record) =>
        object(object(record.payload).body).kind === 'domain-bootstrap',
    );
    await homeFact(
      edge,
      pairing,
      'room:' + roomId,
      (record) =>
        roomView(record).steps.some((step) => step.eventId === eventId),
    );
    // Observe actual received/applied semantic streams, not merely the older F1
    // public snapshot. No test calls the link exporters or importers directly.
    await homeFact(edge, pairing, 'devices:' + user, (record) => {
      const operation = object(object(record.payload).body)
        .operation as DeviceOperation;
      return operation.deviceId === homeDevice &&
        object(object(operation.value?.keys ?? {}).keys ?? {})[
            'ed25519:' + homeDevice
          ] === homePublic;
    });
    await homeFact(edge, pairing, 'signing:' + user, (record) => {
      const operation = object(object(record.payload).body)
        .operation as SigningOperation;
      return operation.keys.some((item) =>
        item.usage === 'master' &&
        object(item.key.keys)['ed25519:' + masterPublic] === masterPublic
      );
    });
    const homeSignature = (master as typeof master & {
      signatures: Record<string, Record<string, string>>;
    }).signatures[user]['ed25519:' + homeDevice];
    await homeFact(edge, pairing, 'signatures:' + user, (record) => {
      const operation = object(object(record.payload).body)
        .operation as SignatureOperation;
      return operation.target.user === user &&
        operation.target.id === masterPublic &&
        operation.signers.some((item) =>
          item.signer.key === 'ed25519:' + homeDevice &&
          item.signature === homeSignature
        );
    });
    await home.stop();
    await edge.stop();
    // Join every admitted receive before selecting the offline key-stream cut.
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await finiteStreams(
      edge,
      tls.dir + '/facade-auth.sock',
      ['devices:', 'signing:', 'signatures:'].map((prefix) => prefix + user),
    );
    await edge.stop();
    const offline = await open('facade');
    let token: string;
    let edgeEventId: string;
    let edgeKeyId: string;
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
      const server = await offline.server();
      const node = await loadNode(server, 'logical.test', 'edge_a');
      edgeKeyId = node.keyId;
      const pairings = new Pairings(
        server,
        node.signer(),
        node.publicKey,
        tls.facadePin,
        node,
      );
      const room = await openRoom(offline, roomId);
      const authored = await sendLocal(
        room,
        {
          type: 'm.room.encrypted',
          sender: user,
          content: {
            algorithm: 'm.megolm.v1.aes-sha2',
            ciphertext: 'cold-edge-room-branch',
          },
        },
        new FacadeKeys(server, node.signer(), node.publicKey, pairings)
          .requestSigner(),
      );
      assert(authored.completion);
      await completeAccepted(
        { store: offline, tenant },
        roomId,
        authored.eventId,
      );
      edgeEventId = authored.eventId;
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
        tx.toDevice.send(
          device,
          'logical.test',
          'm.room_key_request',
          'cold-runtime-request',
          'cold-runtime-request-source',
          [{ user, id: '*', content: { request_id: 'cold-runtime-key' } }],
          config().e2ee,
          { enabled: false, maxBytes: 1048576 },
        )
      );
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
    await finiteTail(edge, tls.dir + '/facade-auth.sock', [
      'auth:@outside:logical.test',
      'domain:@outside:logical.test',
      'room:' + roomId,
    ]);
    const scopes =
      (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status')).body
        .result.scopes;
    for (
      const required of [
        'auth:@outside:logical.test',
        'domain:@outside:logical.test',
        'room:' + roomId,
      ]
    ) {
      assert(
        scopes.some((scope: { scope: string; ready: boolean }) =>
          scope.scope === required && scope.ready
        ),
      );
    }
    await edge.listening(facadePort);
    // Real public authoring while home is absent and federation is disabled.
    const offlinePresence = 'presence/' + encodeURIComponent(user) + '/status';
    const offlineTyping = roomPath + '/typing/' + encodeURIComponent(user);
    assertEquals(
      await edgeApi(offlinePresence, {
        presence: 'online',
        status_msg: 'offline facade status',
      }, 'PUT'),
      { status: 200, body: {} },
    );
    const offlinePresenceRead = await edgeApi(offlinePresence);
    assertEquals(offlinePresenceRead.status, 200);
    assertEquals(offlinePresenceRead.body.presence, 'online');
    assertEquals(offlinePresenceRead.body.status_msg, 'offline facade status');
    assertEquals(
      await edgeApi(offlineTyping, { typing: true, timeout: 30000 }, 'PUT'),
      { status: 200, body: {} },
    );
    const offlineActivitySync = await edgeApi(
      'sync?timeout=0&set_presence=online',
    );
    assertEquals(offlineActivitySync.status, 200);
    assert(
      offlineActivitySync.body.rooms.join[roomId].ephemeral.events.some((
        event: { type: string; content: { user_ids?: string[] } },
      ) => event.type === 'm.typing' && event.content.user_ids?.includes(user)),
    );
    for (
      const [path, method, body] of [
        [offlinePresence, 'GET', undefined],
        [offlinePresence, 'PUT', { presence: 'offline' }],
        [offlineTyping, 'PUT', { typing: false }],
      ] as const
    ) {
      assertEquals(
        (await api(path, body, undefined, method, facadePort)).status,
        401,
      );
      assertEquals(
        (await api(
          path,
          body,
          registered.body.access_token,
          method,
          facadePort,
        )).status,
        503,
      );
    }
    assertEquals(
      (await edgeApi('presence/%40other%3Alogical.test/status', {
        presence: 'online',
      }, 'PUT')).status,
      403,
    );
    assertEquals(await edgeApi(offlineTyping, { typing: false }, 'PUT'), {
      status: 200,
      body: {},
    });
    assertEquals(
      await edgeApi(offlinePresence, { presence: 'offline' }, 'PUT'),
      { status: 200, body: {} },
    );
    const forgottenRoom = await edgeApi('createRoom', {
      preset: 'public_chat',
      initial_state: [{
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
    });
    assertEquals(forgottenRoom.status, 200, JSON.stringify(forgottenRoom));
    const forgottenPath = 'rooms/' +
      encodeURIComponent(forgottenRoom.body.room_id);
    assertEquals((await edgeApi(forgottenPath + '/leave', {})).status, 200);
    assertEquals(await edgeApi(forgottenPath + '/forget', {}), {
      status: 200,
      body: {},
    });
    assertEquals(
      (await edgeApi(forgottenPath + '/messages?dir=b')).status,
      403,
    );
    const reportPaths = [
      roomPath + '/report',
      roomPath + '/report/' + encodeURIComponent(edgeEventId),
      'users/' + encodeURIComponent(user) + '/report',
    ];
    for (const path of reportPaths) {
      assertEquals(
        await edgeApi(path, {
          reason: 'cold-offline-private-report',
          ...(path.includes('/report/') ? { score: -1 } : {}),
        }, 'POST'),
        { status: 200, body: {} },
      );
    }
    assertEquals(
      await edgeApi('users/%40nonexistent%3Alogical.test/report', {
        reason: 'no disclosure',
      }, 'POST'),
      { status: 200, body: {} },
    );
    assertEquals(
      await edgeApi('users/%40remote%3Aelsewhere.test/report', {
        reason: 'no disclosure',
      }, 'POST'),
      { status: 200, body: {} },
    );
    const offlineReports =
      (await adminCall(tls.dir + '/facade-auth.sock', 'reports/list')).body
        .result.reports;
    assertEquals(offlineReports.length, 3);
    assertEquals(
      new Set(offlineReports.map((r: { reportId: string }) => r.reportId)).size,
      3,
    );
    assertEquals(
      (await adminCall(tls.dir + '/facade-auth.sock', 'reports/resolve', {
        id: offlineReports[0].id,
        resolution: 'forbidden edge resolution',
      })).status,
      503,
    );
    assertEquals(await edgeApi(filterPath + '/' + homeFilter.body.filter_id), {
      status: 200,
      body: homeFilterBody,
    });
    const edgeFilterBody = { room: { timeline: { limit: 3 } } };
    const edgeFilter = await edgeApi(filterPath, edgeFilterBody, 'POST');
    assertEquals(edgeFilter.status, 200);
    assert(edgeFilter.body.filter_id !== homeFilter.body.filter_id);
    assertEquals(await edgeApi(filterPath + '/' + edgeFilter.body.filter_id), {
      status: 200,
      body: edgeFilterBody,
    });
    assertEquals(await openIdInfo(homeOpenId.body.access_token), {
      status: 200,
      body: { sub: user },
    });
    const edgeOpenId = await edgeApi(openIdPath, {}, 'POST');
    assertEquals(edgeOpenId.status, 200);
    assertEquals(edgeOpenId.body.token_type, 'Bearer');
    assertEquals(edgeOpenId.body.matrix_server_name, 'logical.test');
    assertEquals(await openIdInfo(edgeOpenId.body.access_token), {
      status: 200,
      body: { sub: user },
    });
    assertEquals((await openIdInfo()).body.errcode, 'M_MISSING_TOKEN');
    assertEquals((await openIdInfo('invalid')).body.errcode, 'M_UNKNOWN_TOKEN');
    const expectedBackup = {
      ...backupMetadata,
      version: backupVersion,
      count: 1,
      etag: '1',
    };
    assertEquals(await edgeApi('room_keys/version'), {
      status: 200,
      body: expectedBackup,
    });
    assertEquals(await edgeApi('room_keys/version/' + backupVersion), {
      status: 200,
      body: expectedBackup,
    });
    assertEquals(await edgeApi('room_keys/keys?version=' + backupVersion), {
      status: 200,
      body: {
        rooms: {
          '!backup:logical.test': { sessions: { session: backupSession } },
        },
      },
    });
    assertEquals(
      await edgeApi(
        'room_keys/keys/!backup%3Alogical.test?version=' + backupVersion,
      ),
      { status: 200, body: { sessions: { session: backupSession } } },
    );
    assertEquals(
      await edgeApi(
        'room_keys/keys/!backup%3Alogical.test/session?version=' +
          backupVersion,
      ),
      { status: 200, body: backupSession },
    );
    assertEquals((await edgeApi('room_keys/version/missing')).status, 404);
    for (
      const [path, method] of [
        ['room_keys/version', 'POST'],
        ['room_keys/version/' + backupVersion, 'PUT'],
        ['room_keys/version/' + backupVersion, 'DELETE'],
        ...[
          'room_keys/keys',
          'room_keys/keys/!backup%3Alogical.test',
          'room_keys/keys/!backup%3Alogical.test/session',
        ].flatMap((path) =>
          ['PUT', 'DELETE'].map((
            method,
          ) => [path + '?version=' + backupVersion, method])
        ),
      ]
    ) {
      assertEquals(
        await edgeApi(path, method === 'DELETE' ? undefined : {}, method),
        {
          status: 503,
          body: {
            errcode: 'M_UNAVAILABLE',
            error: 'operation requires home ingress',
          },
        },
      );
    }
    assertEquals(
      (await api(
        'account/whoami',
        undefined,
        edgeOpenId.body.access_token,
        'GET',
        facadePort,
      )).status,
      401,
    );
    // This room has never existed at home or in its exported inventory.
    const fresh = await edgeApi('createRoom', {
      room_version: '11',
      name: 'facade-domain-context',
      // The corpus deliberately enables permissive encryption policy for its
      // legacy fixtures; this client explicitly requests an encrypted room.
      initial_state: [{
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
    }, 'POST');
    assertEquals(fresh.status, 200, JSON.stringify(fresh.body));
    const freshRoomPath = 'rooms/' + encodeURIComponent(fresh.body.room_id);
    const freshEncryption = await edgeApi(
      freshRoomPath + '/state/m.room.encryption',
    );
    assertEquals(
      freshEncryption.status,
      200,
      JSON.stringify(freshEncryption.body),
    );
    assertEquals(freshEncryption.body.algorithm, 'm.megolm.v1.aes-sha2');
    assertEquals(
      (await edgeApi(freshRoomPath + '/joined_members')).body.joined[user] !==
        undefined,
      true,
    );
    const freshContent = {
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'public-edge-new-room',
    };
    const freshSendPath = freshRoomPath +
      '/send/m.room.encrypted/public-original';
    const freshEvent = await edgeApi(freshSendPath, freshContent, 'PUT');
    assertEquals(freshEvent.status, 200, JSON.stringify(freshEvent.body));
    assertEquals(await edgeApi(freshSendPath, freshContent, 'PUT'), freshEvent);
    const readAdapter = (path: string, version = 'v1', bearer = token) =>
      api(path, undefined, bearer, 'GET', facadePort, version);
    const freshId = encodeURIComponent(fresh.body.room_id);
    for (
      const [version, path] of [
        ['v1', 'room_summary/' + freshId],
        ['unstable', 'im.nheko.summary/summary/' + freshId],
        ['unstable', 'im.nheko.summary/rooms/' + freshId + '/summary'],
      ]
    ) {
      const summary = await readAdapter(path, version);
      assertEquals(summary.status, 200, JSON.stringify(summary));
      assertEquals(summary.body.room_id, fresh.body.room_id);
      assertEquals(summary.body.name, 'facade-domain-context');
      assertEquals(summary.body.join_rule, 'invite');
      assertEquals(
        (await readAdapter(path, version, registered.body.access_token)).status,
        503,
      );
    }
    const hierarchy = await readAdapter(freshRoomPath + '/hierarchy');
    assertEquals(hierarchy.status, 200, JSON.stringify(hierarchy));
    assertEquals(
      hierarchy.body.rooms.map((room: { room_id: string }) => room.room_id),
      [fresh.body.room_id],
    );
    for (const suffix of ['', '/m.annotation', '/m.annotation/m.reaction']) {
      const relations = await readAdapter(
        freshRoomPath + '/relations/' +
          encodeURIComponent(freshEvent.body.event_id) + suffix,
      );
      assertEquals(relations.status, 200, JSON.stringify(relations));
      assertEquals(relations.body.chunk, []);
    }
    const threads = await readAdapter(freshRoomPath + '/threads');
    assertEquals(threads.status, 200, JSON.stringify(threads));
    assertEquals(threads.body.chunk, []);
    const timestamp = await readAdapter(
      freshRoomPath + '/timestamp_to_event?ts=0&dir=f',
    );
    assertEquals(timestamp.status, 200, JSON.stringify(timestamp));
    assertEquals(typeof timestamp.body.event_id, 'string');
    const legacyMembers = await readAdapter(
      freshRoomPath + '/joined_members',
      'r0',
    );
    assertEquals(legacyMembers.status, 200, JSON.stringify(legacyMembers));
    assertEquals(legacyMembers.body.joined[user] !== undefined, true);
    const legacyMessages = await readAdapter(
      freshRoomPath + '/messages?dir=b&limit=1',
      'r0',
    );
    assertEquals(legacyMessages.status, 200, JSON.stringify(legacyMessages));
    assertEquals(
      legacyMessages.body.chunk[0].event_id,
      freshEvent.body.event_id,
    );
    const preview = await edgeApi(freshRoomPath + '/initialSync');
    const searchContext = await edgeApi('search', {
      search_categories: {
        room_events: {
          search_term: 'facade-domain-context',
          keys: ['content.name'],
          event_context: { before_limit: 1, after_limit: 1 },
        },
      },
    }, 'POST');
    assertEquals(
      [preview.status, searchContext.status],
      [200, 200],
      JSON.stringify({ preview, searchContext }),
    );
    assertEquals(
      searchContext.body.search_categories.room_events.results.length,
      1,
    );
    const page = await edgeApi(freshRoomPath + '/messages?dir=b&limit=1');
    assertEquals(page.status, 200, JSON.stringify(page.body));
    const bookmark = parsePosition(page.body.end);
    assert(bookmark !== null);
    assertEquals(
      (await edgeApi(freshRoomPath + '/messages?dir=b&from=' + page.body.end))
        .status,
      200,
    );
    assertEquals(
      (await edgeApi(
        freshRoomPath + '/messages?dir=b&from=' + bookmark.payload,
      )).status,
      400,
    );
    const foreignPage = await edgeApi(
      freshRoomPath + '/messages?dir=b&from=' +
        formatPosition(crypto.randomUUID(), bookmark.payload),
    );
    assertEquals([foreignPage.status, foreignPage.body.errcode], [
      400,
      'M_INVALID_PARAM',
    ]);
    const searchBookmark =
      searchContext.body.search_categories.room_events.next_batch;
    assert(parsePosition(searchBookmark) !== null);
    const searchNext = await edgeApi('search?next_batch=' + searchBookmark, {
      search_categories: {
        room_events: {
          search_term: 'facade-domain-context',
          keys: ['content.name'],
        },
      },
    }, 'POST');
    assertEquals(searchNext.status, 200, JSON.stringify(searchNext.body));
    const edgeSliding = async (pos?: string) => {
      const response = await fetch(
        `http://127.0.0.1:${facadePort}/_matrix/client/unstable/org.matrix.simplified_msc3575/sync` +
          (pos === undefined ? '' : '?pos=' + pos),
        {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
          body: JSON.stringify({
            conn_id: 'cold-facade-b9',
            room_subscriptions: {
              [fresh.body.room_id]: { timeline_limit: 1, required_state: [] },
            },
            extensions: {
              e2ee: { enabled: true },
              to_device: { enabled: true, limit: 1 },
            },
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    const sliding = await edgeSliding();
    assertEquals(sliding.status, 200, JSON.stringify(sliding.body));
    const slidingPosition = parsePosition(sliding.body.pos);
    assert(slidingPosition !== null);
    assertEquals(slidingPosition.domain, bookmark.domain);
    assertEquals(
      parsePosition(sliding.body.extensions.to_device.next_batch)?.domain,
      bookmark.domain,
    );
    assertEquals(
      sliding.body.rooms[fresh.body.room_id].timeline[0].event_id,
      freshEvent.body.event_id,
    );
    for (
      const foreign of [
        slidingPosition.payload,
        formatPosition(crypto.randomUUID(), slidingPosition.payload),
      ]
    ) {
      const response = await edgeSliding(foreign);
      assertEquals([response.status, response.body.errcode], [
        400,
        'M_UNKNOWN_POS',
      ]);
    }
    assertEquals((await edgeSliding(sliding.body.pos)).status, 200);
    const ordinary = await edgeApi('sync?timeout=0');
    assertEquals(ordinary.status, 200, JSON.stringify(ordinary.body));
    assertEquals(
      parseStreamToken(ordinary.body.next_batch)?.domain,
      bookmark.domain,
    );
    assert(ordinary.body.rooms.join[fresh.body.room_id].timeline.events.some(
      (event: { event_id: string }) =>
        event.event_id === freshEvent.body.event_id,
    ));
    const changes = await edgeApi(
      'keys/changes?from=' + ordinary.body.next_batch + '&to=' +
        ordinary.body.next_batch,
    );
    assertEquals(changes.status, 200, JSON.stringify(changes.body));
    assertEquals(changes.body, { changed: [], left: [] });
    const edit = await edgeApi(
      freshRoomPath + '/send/m.room.encrypted/public-edit',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'public-edit',
        'm.relates_to': {
          rel_type: 'm.replace',
          event_id: freshEvent.body.event_id,
        },
      },
      'PUT',
    );
    assertEquals(edit.status, 200, JSON.stringify(edit.body));
    const reaction = await edgeApi(
      freshRoomPath + '/send/m.room.encrypted/public-reaction',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'public-reaction',
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: freshEvent.body.event_id,
          key: 'like',
        },
      },
      'PUT',
    );
    assertEquals(reaction.status, 200, JSON.stringify(reaction.body));
    for (const suffix of ['', '/']) {
      assertEquals(
        (await edgeApi(freshRoomPath + '/state/m.room.topic' + suffix, {
          topic: 'offline-public',
        }, 'PUT')).status,
        200,
      );
      assertEquals(
        (await edgeApi(freshRoomPath + '/state/m.room.topic' + suffix)).body,
        { topic: 'offline-public' },
      );
    }
    const freshRead = await edgeApi(
      freshRoomPath + '/event/' + encodeURIComponent(freshEvent.body.event_id),
    );
    assertEquals(freshRead.status, 200);
    assertEquals(freshRead.body.content, freshContent);
    const pollInitial = await edgeApi(freshRoomPath + '/initialSync');
    assertEquals(pollInitial.status, 200, JSON.stringify(pollInitial.body));
    const pollPath = 'events?room_id=' +
      encodeURIComponent(fresh.body.room_id) + '&timeout=0&from=';
    const polledContent = {
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'offline-event-poll',
    };
    const polledEvent = await edgeApi(
      freshRoomPath + '/send/m.room.encrypted/public-event-poll',
      polledContent,
      'PUT',
    );
    assertEquals(polledEvent.status, 200);
    const polled = await edgeApi(
      pollPath + encodeURIComponent(pollInitial.body.messages.end),
    );
    assertEquals(polled.status, 200, JSON.stringify(polled.body));
    assertEquals(polled.body.start, pollInitial.body.messages.end);
    const observed = polled.body.chunk.find((event: { event_id: string }) =>
      event.event_id === polledEvent.body.event_id
    );
    assert(observed);
    assertEquals(observed.content, polledContent);
    assertEquals(
      (await edgeApi(pollPath + encodeURIComponent(polled.body.end))).body
        .chunk,
      [],
    );
    assertEquals(await edgeApi('events'), {
      status: 404,
      body: { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' },
    });
    assertEquals(
      (await api('events', undefined, undefined, 'GET', facadePort)).status,
      404,
    );
    const foreignPoll = await edgeApi(
      pollPath + encodeURIComponent(formatPosition(
        crypto.randomUUID(),
        parsePosition(pollInitial.body.messages.end)!.payload,
      )),
    );
    assertEquals(foreignPoll.status, 400);
    assertEquals(foreignPoll.body.errcode, 'M_UNKNOWN_POS');
    for (
      const [token, status] of [
        [undefined, 401],
        [registered.body.access_token, 503],
      ] as const
    ) {
      assertEquals(
        (await api(
          pollPath + encodeURIComponent(polled.body.end),
          undefined,
          token,
          'GET',
          facadePort,
        )).status,
        status,
      );
    }
    const context = await edgeApi(
      freshRoomPath + '/context/' + encodeURIComponent(edit.body.event_id),
    );
    assertEquals(context.status, 200, JSON.stringify(context.body));
    assertEquals(context.body.event.event_id, edit.body.event_id);
    const messages = await edgeApi(freshRoomPath + '/messages?dir=b&limit=100');
    assertEquals(messages.status, 200, JSON.stringify(messages.body));
    assert(
      messages.body.chunk.some((event: { event_id: string }) =>
        event.event_id === freshEvent.body.event_id
      ),
    );
    const redactPath = freshRoomPath + '/redact/' +
      encodeURIComponent(reaction.body.event_id) + '/public-redact';
    const redaction = await edgeApi(redactPath, {}, 'PUT');
    assertEquals(redaction.status, 200, JSON.stringify(redaction.body));
    assertEquals(await edgeApi(redactPath, {}, 'PUT'), redaction);
    assertEquals(
      (await edgeApi(
        freshRoomPath + '/event/' + encodeURIComponent(reaction.body.event_id),
      )).body.content,
      {},
    );
    for (
      const variant of [{ room_alias_name: 'must-stay-home' }, {
        visibility: 'public',
      }]
    ) {
      const refused = await edgeApi('createRoom', variant, 'POST');
      assertEquals(refused.status, 503);
      assertEquals(refused.body.errcode, 'M_UNAVAILABLE');
    }
    const boundaryRooms = await edgeApi('joined_rooms');
    assertEquals(await edgeApi(roomPath + '/upgrade', { new_version: '12' }), {
      status: 503,
      body: {
        errcode: 'M_UNAVAILABLE',
        error: 'operation requires home ingress',
      },
    });
    assertEquals(await edgeApi('joined_rooms'), boundaryRooms);
    assertEquals(
      (await edgeApi(roomPath + '/state/m.room.tombstone')).status,
      404,
    );
    const aliasPath = 'directory/room/' +
      encodeURIComponent('#upgrade-home-boundary:logical.test');
    assertEquals(
      await edgeApi('directory/list/room/' + encodeURIComponent(roomId)),
      {
        status: 200,
        body: { visibility: 'public' },
      },
    );
    assertEquals(await edgeApi(aliasPath), {
      status: 200,
      body: { room_id: roomId, servers: ['logical.test'] },
    });
    assertEquals(await edgeApi(roomPath + '/aliases'), {
      status: 200,
      body: { aliases: ['#upgrade-home-boundary:logical.test'] },
    });
    assertEquals(await edgeApi(freshRoomPath + '/aliases'), {
      status: 200,
      body: { aliases: [] },
    });
    assertEquals(
      (await api(
        roomPath + '/aliases',
        undefined,
        undefined,
        'GET',
        facadePort,
      )).status,
      401,
    );
    assertEquals(
      (await api(
        roomPath + '/aliases',
        undefined,
        registered.body.access_token,
        'GET',
        facadePort,
      )).status,
      503,
    );
    for (const method of ['GET', 'POST']) {
      const result = await edgeApi(
        'publicRooms',
        method === 'POST' ? {} : undefined,
        method,
      );
      assertEquals(result.status, 200, JSON.stringify(result));
      assert(
        result.body.chunk.some((room: { room_id: string }) =>
          room.room_id === roomId
        ),
      );
      assert(
        !result.body.chunk.some((room: { room_id: string }) =>
          room.room_id === fresh.body.room_id
        ),
      );
    }
    const anonymousAlias = await fetch(
      `http://127.0.0.1:${facadePort}/_matrix/client/v3/` + aliasPath,
    );
    assertEquals(anonymousAlias.status, 200);
    assertEquals(await anonymousAlias.json(), {
      room_id: roomId,
      servers: ['logical.test'],
    });
    for (
      const [path, method, body] of [
        [aliasPath, 'DELETE', undefined],
        [
          'directory/room/' +
          encodeURIComponent('#must-stay-home:logical.test'),
          'PUT',
          { room_id: fresh.body.room_id },
        ],
        ['directory/list/room/' + encodeURIComponent(roomId), 'PUT', {
          visibility: 'private',
        }],
      ] as const
    ) {
      assertEquals(await edgeApi(path, body, method), {
        status: 503,
        body: {
          errcode: 'M_UNAVAILABLE',
          error: 'operation requires home ingress',
        },
      });
    }
    assertEquals((await edgeApi(aliasPath)).body.room_id, roomId);
    assertEquals(
      (await edgeApi('directory/list/room/' + encodeURIComponent(roomId))).body
        .visibility,
      'public',
    );
    assertEquals(
      (await edgeApi(
        'directory/room/' + encodeURIComponent('#must-stay-home:logical.test'),
      )).status,
      404,
    );
    const upgradeSeed = await edgeApi('createRoom', {
      room_version: '11',
      initial_state: [{
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
    }, 'POST');
    assertEquals(upgradeSeed.status, 200);
    const upgradePath = 'rooms/' +
      encodeURIComponent(upgradeSeed.body.room_id) + '/upgrade';
    const upgraded = await edgeApi(upgradePath, { new_version: '12' }, 'POST');
    assertEquals(upgraded.status, 200, JSON.stringify(upgraded));
    assertEquals(
      await edgeApi(upgradePath, { new_version: '12' }, 'POST'),
      upgraded,
    );
    const replacementPath = 'rooms/' +
      encodeURIComponent(upgraded.body.replacement_room);
    assertEquals(
      (await edgeApi(replacementPath + '/state/m.room.create')).body.predecessor
        .room_id,
      upgradeSeed.body.room_id,
    );
    assertEquals(
      (await edgeApi(replacementPath + '/state/m.room.encryption')).body
        .algorithm,
      'm.megolm.v1.aes-sha2',
    );
    const upgradeTombstone = await edgeApi(
      'rooms/' + encodeURIComponent(upgradeSeed.body.room_id) +
        '/state/m.room.tombstone',
    );
    assertEquals(
      upgradeTombstone.body.replacement_room,
      upgraded.body.replacement_room,
    );
    const upgradedEvent = await edgeApi(
      replacementPath + '/send/m.room.encrypted/upgrade-offline',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'offline-upgraded-room',
      },
      'PUT',
    );
    assertEquals(upgradedEvent.status, 200);
    // Both replicas author independent encrypted and state branches under the
    // same logical server while home has no running link process.
    const edgeBranch = await edgeApi(
      roomPath + '/send/m.room.encrypted/public-concurrent',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'edge-concurrent-encrypted',
      },
      'PUT',
    );
    assertEquals(edgeBranch.status, 200, JSON.stringify(edgeBranch.body));
    const edgeTopic = await edgeApi(roomPath + '/state/m.room.topic', {
      topic: 'edge-concurrent-topic',
    }, 'PUT');
    assertEquals(edgeTopic.status, 200, JSON.stringify(edgeTopic.body));
    const homeBranch = await (async () => {
      const isolated = await open('home');
      try {
        const tenant = await openTenant(isolated, 'logical.test');
        const room = await openRoom(isolated, roomId);
        const message = await sendLocal(room, {
          type: 'm.room.encrypted',
          sender: user,
          content: {
            algorithm: 'm.megolm.v1.aes-sha2',
            ciphertext: 'home-concurrent-encrypted',
          },
        }, tenant.signer());
        assert(message.completion);
        await completeAccepted(
          { store: isolated, tenant },
          roomId,
          message.eventId,
        );
        const topic = await sendLocal(room, {
          type: 'm.room.topic',
          state_key: '',
          sender: user,
          content: { topic: 'home-concurrent-topic' },
        }, tenant.signer());
        assert(topic.completion);
        await completeAccepted(
          { store: isolated, tenant },
          roomId,
          topic.eventId,
        );
        return { message: message.eventId, topic: topic.eventId };
      } finally {
        await isolated.close();
      }
    })();
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
      assertEquals(
        await server.query('SELECT * FROM room_upgrades WHERE old_room_id=?', [
          roomId,
        ]),
        [],
      );
      assertEquals(
        await lookupAlias(server, '#upgrade-home-boundary:logical.test'),
        roomId,
      );
      assertEquals(await visibility(server, roomId), 'public');
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
    await home.listening(homePort);
    const edgeIncarnation =
      (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status')).body
        .result.incarnation;
    const edgeIdentity = {
      peer: 'edge_a',
      source: 'edge_a',
      incarnation: edgeIncarnation,
    };
    for (const report of offlineReports) {
      await home.observations.fact({
        ...edgeIdentity,
        stream: 'domain:' + user,
      }, (record) => {
        const body = object(object(record.payload).body);
        if (body.kind !== 'domain-operation') return false;
        const operation = object(body.operation);
        return operation.kind === 'report' &&
          JSON.parse(String(operation.payload)).reportId === report.reportId;
      });
    }
    const homeReports =
      (await adminCall(tls.dir + '/home-auth.sock', 'reports/list')).body.result
        .reports;
    assertEquals(homeReports.length, 3);
    for (const expected of offlineReports) {
      const actual = homeReports.find((r: { reportId: string }) =>
        r.reportId === expected.reportId
      );
      assert(actual);
      assertEquals({ ...actual, id: expected.id }, expected);
    }
    const resolvedReport = await adminCall(
      tls.dir + '/home-auth.sock',
      'reports/resolve',
      { id: homeReports[0].id, resolution: 'home-real-wire-resolution' },
    );
    assertEquals(resolvedReport.status, 200);
    const homeResolution = resolvedReport.body.result;
    await homeFact(edge, pairing, 'domain:' + user, (record) => {
      const body = object(object(record.payload).body);
      if (body.kind !== 'domain-operation') return false;
      const operation = object(body.operation);
      return operation.kind === 'report-resolution' &&
        JSON.parse(String(operation.payload)).reportId ===
          homeResolution.reportId;
    });
    // Retain B6's actual consumers, but observe their exact applied facts using
    // main's causal helper. No timer or repeated HTTP request substitutes for
    // the import owner completing the original facade-signed event.
    const edgeRoomFact = (id: string, room = roomId) =>
      home!.observations.fact(
        { ...edgeIdentity, stream: 'room:' + room },
        (record) => roomView(record).steps.some((step) => step.eventId === id),
      );
    await edgeRoomFact(edgeEventId);
    await home.observations.fact({
      ...edgeIdentity,
      stream: 'domain:@outside:logical.test',
    }, (record) => {
      const operation = object(object(object(record.payload).body).operation);
      return operation.semanticKey ===
          JSON.stringify([
            'account-data',
            'outside',
            '',
            'm.secret_storage.key',
          ]) &&
        JSON.parse(String(operation.payload)).ciphertext === 'edge-public';
    });
    const reverseResponse = await api(
      roomPath + '/event/' + encodeURIComponent(edgeEventId),
      undefined,
      registered.body.access_token,
    );
    assertEquals(reverseResponse.status, 200, JSON.stringify(reverseResponse));
    assertEquals(reverseResponse.body.event_id, edgeEventId);
    assertEquals(
      reverseResponse.body.content.ciphertext,
      'cold-edge-room-branch',
    );
    // Observe both eligible event sets before comparing resolved current
    // state. An ACK is not a promise that its branch wins the topic.
    for (const id of [edgeBranch.body.event_id, edgeTopic.body.event_id]) {
      await home.observations.fact(
        {
          ...edgeIdentity,
          stream: 'room:' + roomId,
        },
        (record) => roomView(record).steps.some((step) => step.eventId === id),
      );
    }
    for (const id of [homeBranch.message, homeBranch.topic]) {
      await homeFact(
        edge,
        pairing,
        'room:' + roomId,
        (record) => roomView(record).steps.some((step) => step.eventId === id),
      );
    }
    const homeContents = new Map<string, unknown>();
    for (
      const id of [
        edgeBranch.body.event_id,
        edgeTopic.body.event_id,
        homeBranch.message,
        homeBranch.topic,
      ]
    ) {
      const path = roomPath + '/event/' + encodeURIComponent(id);
      const [homeRead, edgeRead] = await Promise.all([
        api(path, undefined, registered.body.access_token),
        edgeApi(path),
      ]);
      assertEquals(homeRead.status, 200);
      assertEquals(
        edgeRead.status,
        200,
        edgeRead.status === 200 ? undefined : JSON.stringify({
          response: edgeRead.body,
          status:
            (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status'))
              .body.result,
        }),
      );
      assertEquals(homeRead.body.event_id, id);
      assertEquals(edgeRead.body.event_id, id);
      assertEquals(homeRead.body.content, edgeRead.body.content);
      homeContents.set(id, homeRead.body.content);
    }
    const [homeState, edgeState] = await Promise.all([
      api(
        roomPath + '/state/m.room.topic',
        undefined,
        registered.body.access_token,
      ),
      edgeApi(roomPath + '/state/m.room.topic'),
    ]);
    assertEquals(homeState.status, 200);
    assertEquals(edgeState.status, 200);
    assert(
      ['home-concurrent-topic', 'edge-concurrent-topic'].includes(
        homeState.body.topic,
      ),
    );
    assertEquals(homeState.body.topic, edgeState.body.topic);
    await edgeRoomFact(freshEvent.body.event_id, fresh.body.room_id);
    await edgeRoomFact(
      upgradedEvent.body.event_id,
      upgraded.body.replacement_room,
    );
    const homeUpgradeRead = await api(
      replacementPath + '/event/' +
        encodeURIComponent(upgradedEvent.body.event_id),
      undefined,
      registered.body.access_token,
    );
    assertEquals(homeUpgradeRead.status, 200, JSON.stringify(homeUpgradeRead));
    assertEquals(
      homeUpgradeRead.body.content.ciphertext,
      'offline-upgraded-room',
    );
    const freshHomeRead = await api(
      freshRoomPath + '/event/' + encodeURIComponent(freshEvent.body.event_id),
      undefined,
      registered.body.access_token,
    );
    assertEquals(freshHomeRead.status, 200);
    assertEquals(
      freshHomeRead.body.content.ciphertext,
      freshContent.ciphertext,
    );
    const freshHomeSuffix = await api(
      freshRoomPath + '/send/m.room.encrypted/public-home-suffix',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'home-after-public-bootstrap',
      },
      registered.body.access_token,
      'PUT',
    );
    assertEquals(
      freshHomeSuffix.status,
      200,
      JSON.stringify(freshHomeSuffix.body),
    );
    await homeFact(
      edge,
      pairing,
      'room:' + fresh.body.room_id,
      (record) =>
        roomView(record).steps.some((step) =>
          step.eventId === freshHomeSuffix.body.event_id
        ),
    );
    const freshEdgeRead = await edgeApi(
      freshRoomPath + '/event/' +
        encodeURIComponent(freshHomeSuffix.body.event_id),
    );
    assertEquals(freshEdgeRead.status, 200);
    assertEquals(
      freshEdgeRead.body.content.ciphertext,
      'home-after-public-bootstrap',
    );
    const suffix = await api(
      roomPath + '/send/m.room.encrypted/b6-return-suffix',
      {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'home-after-cold-edge-branch',
      },
      registered.body.access_token,
      'PUT',
    );
    assertEquals(suffix.status, 200);
    // The retained manifest supplies the exact source cut, without restarting
    // a process or polling a consumer to manufacture a completion boundary.
    const appliedSuffix = await homeFact(
      edge,
      pairing,
      'room:' + roomId,
      (record) =>
        roomView(record).steps.some((step) =>
          step.eventId === suffix.body.event_id
        ),
    );
    const suffixCut = roomView(appliedSuffix).cut;
    const suffixState =
      (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status')).body
        .result;
    assert(
      suffixState.scopes.some((
        scope: { scope: string; cut: number; ready: boolean },
      ) =>
        scope.scope === 'room:' + roomId && scope.ready &&
        scope.cut >= suffixCut
      ),
    );
    assertEquals(
      await api(
        'user/%40outside%3Alogical.test/account_data/m.secret_storage.key',
        undefined,
        registered.body.access_token,
      ),
      { status: 200, body: { ciphertext: 'edge-public' } },
    );
    const tokenHash = await hashToken(token);
    await home.observations.fact(
      { ...edgeIdentity, stream: 'authority:@outside:logical.test' },
      (record) =>
        authorityView(record).authority.sessions.some((session) =>
          session.hash === tokenHash
        ),
    );
    assertEquals((await api('account/whoami', undefined, token)).status, 503);
    // A normal home Matrix consumer observes the cold-recovered facade overlay.
    // Its device basis requires the independent authority and device streams;
    // stream startup or a stored unverified signature alone cannot satisfy this.
    const edgeDeviceRecord = await home.observations.fact({
      ...edgeIdentity,
      stream: 'devices:' + user,
    }, (record) => {
      const operation = object(object(record.payload).body)
        .operation as DeviceOperation;
      return operation.deviceId === 'outside-device' &&
        object(object(operation.value?.keys ?? {}).keys ?? {})[
            'ed25519:outside-device'
          ] === edgePublic;
    });
    const edgeDevice = object(object(edgeDeviceRecord.payload).body)
      .operation as DeviceOperation;
    await home.observations.fact(
      { ...edgeIdentity, stream: 'authority:' + user },
      (record) =>
        authorityView(record).authority.facts.some((fact) =>
          fact.kind === 'device' && fact.id === edgeDevice.deviceIncarnation
        ),
    );
    const edgeSignature = (signedByEdge as typeof signedByEdge & {
      signatures: Record<string, Record<string, string>>;
    }).signatures[user]['ed25519:outside-device'];
    await home.observations.fact({
      ...edgeIdentity,
      stream: 'signatures:' + user,
    }, (record) => {
      const operation = object(object(record.payload).body)
        .operation as SignatureOperation;
      return operation.target.user === user &&
        operation.target.id === masterPublic &&
        operation.signers.some((item) =>
          item.signer.key === 'ed25519:outside-device' &&
          item.signature === edgeSignature
        );
    });
    const query = await api(
      'keys/query',
      { device_keys: { [user]: [] } },
      registered.body.access_token,
    );
    assertEquals(query.status, 200);
    assertEquals(
      query.body.master_keys?.[user]?.signatures?.[user]
        ?.['ed25519:outside-device'],
      edgeSignature,
    );
    // Match the actual home-owned route before consuming cold-authored work.
    await home.observations.fact({
      ...edgeIdentity,
      stream: 'to-device:' + user,
    }, (record) => {
      const operation = toDeviceView(record);
      return operation.kind === 'route' && operation.value.owner === 'home' &&
        operation.value.selectors.some((selector) =>
          selector.content.request_id === 'cold-runtime-key'
        );
    });
    const keySync = await api(
      'sync?timeout=0',
      undefined,
      registered.body.access_token,
    );
    assertEquals(keySync.status, 200, JSON.stringify(keySync));
    assert(keySync.body.to_device.events.some(
      (event: { type: string; content: { request_id?: string } }) =>
        event.type === 'm.room_key_request' &&
        event.content.request_id === 'cold-runtime-key',
    ));
    assertEquals(
      (await api(
        'sendToDevice/m.room_key_request/runtime-reply',
        {
          messages: {
            [user]: { 'outside-device': { request_id: 'home-runtime-key' } },
          },
        },
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    // The exact reply, not an older wildcard or unrelated larger cut, is proof.
    await homeFact(edge, pairing, 'to-device:' + user, (record) => {
      const operation = toDeviceView(record);
      return operation.kind === 'route' && operation.value.owner === 'edge_a' &&
        operation.value.selectors.some((selector) =>
          selector.id === 'outside-device' &&
          selector.content.request_id === 'home-runtime-key'
        );
    });
    // Real processes exchange live observations over the existing home-initiated
    // link. Ordinary/sliding consumers, not a durable journal ACK, prove receipt.
    const livePresence = 'presence/' + encodeURIComponent(user) + '/status';
    const liveTyping = roomPath + '/typing/' + encodeURIComponent(user);
    const liveMark = edge.observations.mark();
    assertEquals(
      (await api(
        livePresence,
        { presence: 'unavailable' },
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    assertEquals(
      (await api(
        liveTyping,
        { typing: true, timeout: 30000 },
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    const observeLive = async (
      child: Awaited<ReturnType<typeof process>>,
      after: number,
      snapshotMatches: (snapshot: {
        presence: { userId: string; presence: string }[];
        typing: { userId: string; roomId: string }[];
      }) => boolean,
      read: () => ReturnType<typeof api>,
      observed: (body: Awaited<ReturnType<typeof api>>['body']) => boolean,
    ) => {
      const source = child === edge ? home : edge;
      assert(source);
      await observeLiveInput(
        source,
        child,
        pairing,
        after,
        (snapshot) =>
          snapshotMatches(snapshot as Parameters<typeof snapshotMatches>[0]),
      );
      const readScopes = new Set([
        'auth:' + user,
        'domain:' + user,
        'membership:' + user,
        'room:' + roomId,
        'directory',
        'owner-control',
      ]);
      let value;
      for (;;) {
        const readMark = child.observations.mark();
        value = await read();
        if (value.status !== 503 || child !== edge) break;
        assertEquals(value.body.errcode, 'M_UNAVAILABLE');
        // Live application does not seal the ordinary reader's separate scope
        // cut. A refused read waits for real selected-owner application, never
        // an elapsed retry window or a predicate against a missing effect.
        await child.observations.wait(
          (event) =>
            event.kind === 'applied' && event.peer === 'home' &&
            event.record.source === 'home' &&
            event.record.incarnation === pairing &&
            readScopes.has(event.record.stream),
          readMark,
          (scope) =>
            scope.peer === 'home' && scope.source === 'home' &&
            scope.incarnation === pairing && readScopes.has(scope.stream),
        );
      }
      assertEquals(value.status, 200, JSON.stringify(value));
      assert(
        observed(value.body),
        'completed live exchange omitted consumer effect: ' +
          JSON.stringify(value),
      );
      return value.body;
    };
    const liveSync = await observeLive(
      edge,
      liveMark,
      (snapshot) =>
        snapshot.presence.some((v) =>
          v.userId === user && v.presence === 'unavailable'
        ) &&
        snapshot.typing.some((v) => v.userId === user && v.roomId === roomId),
      () => edgeApi('sync?timeout=0&set_presence=offline'),
      (body) =>
        body.presence?.events.some((
          e: { sender: string; content: { presence: string } },
        ) => e.sender === user && e.content.presence === 'unavailable') &&
        body.rooms?.join?.[roomId]?.ephemeral?.events.some((
          e: { type: string; content: { user_ids?: string[] } },
        ) => e.type === 'm.typing' && e.content.user_ids?.includes(user)),
    );
    assertEquals(typeof liveSync.next_batch, 'string');
    const homeLiveMark = home.observations.mark();
    const liveSliding = await fetch(
      `http://127.0.0.1:${facadePort}/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?set_presence=online`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: JSON.stringify({
          conn_id: 'cold-live-activity',
          room_subscriptions: {
            [roomId]: { timeline_limit: 0, required_state: [] },
          },
          extensions: { typing: { enabled: true } },
        }),
      },
    );
    assertEquals(liveSliding.status, 200);
    const liveSlidingBody = await liveSliding.json();
    assertEquals(
      liveSlidingBody.extensions.typing.rooms[roomId].content.user_ids,
      [user],
    );
    assertEquals(
      (await api(
        livePresence,
        { presence: 'offline' },
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    await observeLive(
      home,
      homeLiveMark,
      (snapshot) =>
        snapshot.presence.some((v) =>
          v.userId === user && v.presence === 'online'
        ),
      () => api(livePresence, undefined, registered.body.access_token),
      (body) => body.presence === 'online',
    );
    const stopTypingMark = edge.observations.mark();
    assertEquals(
      (await api(
        liveTyping,
        { typing: false },
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    await observeLive(
      edge,
      stopTypingMark,
      (snapshot) =>
        !snapshot.typing.some((v) => v.userId === user && v.roomId === roomId),
      () => edgeApi('sync?timeout=0&set_presence=offline'),
      (body) =>
        !body.rooms?.join?.[roomId]?.ephemeral?.events.some((
          e: { type: string; content: { user_ids?: string[] } },
        ) => e.type === 'm.typing' && e.content.user_ids?.includes(user)),
    );
    // The live consumers above serve applied publications while home runs.
    // A separate cold reopen proves private data and upgrade retry retention.
    const backupSuffix = {
      ...backupSession,
      first_message_index: 1,
      session_data: { ciphertext: 'retained-home-ciphertext-suffix' },
    };
    assertEquals(
      (await api(
        'room_keys/keys/!backup%3Alogical.test/session?version=' +
          backupVersion,
        backupSuffix,
        registered.body.access_token,
        'PUT',
      )).status,
      200,
    );
    await homeFact(edge, pairing, 'domain:' + user, (record) => {
      const body = object(object(record.payload).body);
      if (body.kind !== 'domain-operation') return false;
      const operation = object(body.operation);
      return operation.kind === 'backup' &&
        String(operation.payload).includes('retained-home-ciphertext-suffix');
    });
    await home.stop();
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await finiteTail(edge, tls.dir + '/facade-auth.sock', [
      'directory',
      'auth:' + user,
      'domain:' + user,
      'room:' + roomId,
      'room:' + fresh.body.room_id,
    ]);
    await edge.listening(facadePort);
    assertEquals(
      (await edgeApi(forgottenPath + '/messages?dir=b')).status,
      403,
    );
    assertEquals(
      await edgeApi(upgradePath, { new_version: '12' }, 'POST'),
      upgraded,
    );
    assertEquals(
      await edgeApi(
        'rooms/' + encodeURIComponent(upgradeSeed.body.room_id) +
          '/state/m.room.tombstone',
      ),
      upgradeTombstone,
    );
    assertEquals(
      (await edgeApi(
        replacementPath + '/event/' +
          encodeURIComponent(upgradedEvent.body.event_id),
      )).body.content.ciphertext,
      'offline-upgraded-room',
    );
    assertEquals((await edgeApi(forgottenPath + '/join', {})).status, 200);
    assertEquals(
      (await edgeApi(forgottenPath + '/messages?dir=b')).status,
      200,
    );
    assertEquals(await edgeApi(filterPath + '/' + edgeFilter.body.filter_id), {
      status: 200,
      body: edgeFilterBody,
    });
    assertEquals(
      (await adminCall(tls.dir + '/facade-auth.sock', 'reports/list')).body
        .result.reports,
      offlineReports.map((report: { id: number; reportId: string }) =>
        report.reportId === homeResolution.reportId
          ? { ...homeResolution, id: report.id }
          : report
      ),
    );
    assertEquals(await openIdInfo(homeOpenId.body.access_token), {
      status: 200,
      body: { sub: user },
    });
    assertEquals(await openIdInfo(edgeOpenId.body.access_token), {
      status: 200,
      body: { sub: user },
    });
    assertEquals(await edgeApi('room_keys/version'), {
      status: 200,
      body: { ...expectedBackup, etag: '2' },
    });
    assertEquals(
      await edgeApi(
        'room_keys/keys/!backup%3Alogical.test/session?version=' +
          backupVersion,
      ),
      { status: 200, body: backupSuffix },
    );
    for (const [id, content] of homeContents) {
      const edgeRead = await edgeApi(
        roomPath + '/event/' + encodeURIComponent(id),
      );
      assertEquals(edgeRead.status, 200, JSON.stringify({ id, ...edgeRead }));
      assertEquals(edgeRead.body.event_id, id);
      assertEquals(edgeRead.body.content, content);
    }
    const restoredEdgeState = await edgeApi(roomPath + '/state/m.room.topic');
    assertEquals(
      restoredEdgeState.status,
      200,
      JSON.stringify(restoredEdgeState),
    );
    assertEquals(restoredEdgeState.body.topic, homeState.body.topic);
    const freshSuffixRead = await edgeApi(
      freshRoomPath + '/event/' +
        encodeURIComponent(freshHomeSuffix.body.event_id),
    );
    assertEquals(freshSuffixRead.status, 200, JSON.stringify(freshSuffixRead));
    assertEquals(
      freshSuffixRead.body.content.ciphertext,
      'home-after-public-bootstrap',
    );
    await edge.stop();
    const delivered = await open('facade');
    try {
      const room = await openRoom(delivered, roomId);
      const returned = await room.tx((tx) =>
        tx.events.get(suffix.body.event_id)
      );
      assert(returned);
      assertEquals(
        JSON.parse(returned.pdu).content.ciphertext,
        'home-after-cold-edge-branch',
      );
      assertEquals(
        (await room.tx((tx) => tx.events.getStatus(suffix.body.event_id)))
          ?.standing,
        'accepted',
      );
      const tenant = await openTenant(delivered, 'logical.test');
      const device = await deviceIdentity(tenant, 'outside', 'outside-device');
      const page = await tenant.tx((tx) =>
        tx.toDevice.deliverSliding(
          device,
          'runtime-observation',
          100,
          config().e2ee,
        )
      );
      assertEquals(
        page.events.filter((event) =>
          event.type === 'm.room_key_request' &&
          (event.content as { request_id?: string }).request_id ===
            'home-runtime-key'
        ).length,
        1,
      );
    } finally {
      await delivered.close();
    }
    edge = await process(file('facade'), 'facade: link/local admin ready');
    // The cold private-data proof above deliberately kept home stopped. Bring
    // its real authority back before authoring and observing the logout barrier.
    home = await process(file('home'), 'federation: disabled');
    await home.listening(homePort);
    const before =
      (await adminCall(tls.dir + '/facade-auth.sock', 'facade/status')).body
        .result.scopes.find((scope: { scope: string }) =>
          scope.scope === 'auth:@outside:logical.test'
        ).cut;
    assertEquals(
      (await api('logout/all', {}, registered.body.access_token)).status,
      200,
    );
    await homeFact(
      edge,
      pairing,
      'auth:@outside:logical.test',
      (record) =>
        authView(record).sourceCut > before &&
        authView(record).authority.facts.some((fact) =>
          fact.kind === 'barrier'
        ),
    );
    // Captures already queued before logout can advance a numeric cut too.
    // Observe revocation at the actual authenticated consumer before closing.
    {
      const response = await fetch(
        `http://127.0.0.1:${facadePort}/_matrix/client/v3/account/whoami`,
        { headers: { authorization: 'Bearer ' + token } },
      );
      const body = await response.json();
      assertEquals(response.status, 401);
      assertEquals(body.errcode, 'M_UNKNOWN_TOKEN');
    }
    await home.stop();
    await edge.stop();
    const closedHome = await open('home'), closedEdge = await open('facade');
    try {
      const homeKeyId = (await openTenant(closedHome, 'logical.test')).keyId;
      for (const store of [closedHome, closedEdge]) {
        const room = await store.room(roomId);
        const replica = await openRoom(store, roomId);
        for (
          const [id, keyId] of [
            [edgeEventId, edgeKeyId],
            [suffix.body.event_id, homeKeyId],
          ]
        ) {
          const event = await replica.tx((tx) => tx.events.get(id));
          assert(event);
          assertEquals(
            typeof JSON.parse(event.pdu).signatures['logical.test'][keyId],
            'string',
          );
          assertEquals(
            (await room.query(
              "SELECT COUNT(*) AS n FROM changes WHERE kind='event' AND event=?",
              [id],
            ))[0].n,
            1,
          );
        }
      }
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
  const deliveries: Record<string, unknown>[] = [];
  let gatewayChanged = Promise.withResolvers<void>();
  const gateway = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  }, async (request) => {
    assertEquals(new URL(request.url).pathname, '/_matrix/push/v1/notify');
    assertEquals(request.headers.get('authorization'), null);
    deliveries.push((await request.json()).notification);
    gatewayChanged.resolve();
    gatewayChanged = Promise.withResolvers<void>();
    return Response.json({ rejected: [] });
  });
  const delivered = async (eventId: string) => {
    for (;;) {
      const found = deliveries.find((value) => value.event_id === eventId);
      if (found) return found;
      await gatewayChanged.promise;
    }
  };
  const ports: number[] = [];
  for (let i = 0; i < 3; i++) {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    ports.push(listener.addr.port);
    listener.close();
  }
  const [homePort, facadePort, linkPort] = ports;
  const bundlefile = tls.dir + '/public-auth-bundle.json';
  const file = (side: string) => tls.dir + '/' + side + '-public-auth.toml';
  const configure = async (
    side: string,
    extra = '',
    maxDelay = 60000,
    discovery = false,
  ) => {
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
        extra +
        `\n[delayedevents]\nmaxdelayms=${maxDelay}\n` +
        '\n[push]\ncacerts=["tests/fixtures/tls/ca.crt"]\nallowlist=["127.0.0.1/32"]\n' +
        (discovery
          ? '\n[turn]\nuris=["turn:ingress.test:3478"]\nusername="ingress-user"\npassword="ingress-test-password"\nttl=600\n[matrixrtc]\nlivekitserviceurl="https://rtc.ingress.test/"\n'
          : ''),
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
    assert(edge);
    await finiteTail(
      edge,
      tls.dir + '/facade-public-auth.sock',
      localparts.map((localpart) => 'auth:@' + localpart + ':logical.test'),
    );
  };
  try {
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/initialize');
    home = await process(file('home'), 'federation: disabled');
    await home.listening(homePort);
    assertEquals((await api('home', 'login')).status, 200);
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
    const legacyRoomPath = 'rooms/' +
      encodeURIComponent(departureRoom.body.room_id);
    assertEquals(
      (await api(
        'home',
        legacyRoomPath + '/join',
        {},
        registered.body.access_token,
      )).status,
      200,
    );
    const legacyCiphertext = {
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'saved-home-notification-ciphertext',
      session_id: 'saved-home-session',
    };
    const legacyNotice = await api(
      'home',
      legacyRoomPath + '/send/m.room.encrypted/notification-baseline',
      legacyCiphertext,
      departure.body.access_token,
      'PUT',
    );
    assertEquals(legacyNotice.status, 200);
    const homeNotifications = await api(
      'home',
      'notifications',
      undefined,
      registered.body.access_token,
    );
    assertEquals(homeNotifications.status, 200);
    const originalNotice = homeNotifications.body.notifications.find((
      item: { event: { event_id: string } },
    ) => item.event.event_id === legacyNotice.body.event_id);
    assert(originalNotice, 'home baseline has no saved notification');
    const paired = await adminCall(
      tls.dir + '/home-public-auth.sock',
      'facade/pair',
      {
        node: 'edge_a',
        url: `https://127.0.0.1:${linkPort}`,
        facadePin: tls.facadePin,
        expires: Date.now() + 60000,
        bundlefile,
      },
    );
    assertEquals(paired.status, 200);
    const pairing = paired.body.result.id;
    assertEquals(
      (await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/accept', {
        bundlefile,
      })).status,
      200,
    );
    for (const localpart of ['outside', 'departure']) {
      await homeFact(
        edge,
        pairing,
        'auth:@' + localpart + ':logical.test',
        (record) =>
          authView(record).credentials && authView(record).phc !== null &&
          !authView(record).deactivated,
      );
    }
    await homeFact(
      edge,
      pairing,
      'key-bootstrap:@outside:logical.test',
      () => true,
    );
    await homeFact(
      edge,
      pairing,
      'room:' + departureRoom.body.room_id,
      (record) => roomView(record).roomId === departureRoom.body.room_id,
    );
    await home.stop();
    // Shutdown stops between records; it does not drain the received tail.
    // With home stopped, restart and observe the actual finite auth apply cut
    // before proving cold offline login from durable authority.
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await authTail(['outside', 'departure']);
    await finiteStreams(edge, tls.dir + '/facade-public-auth.sock', [
      'key-bootstrap:@outside:logical.test',
      'devices:@outside:logical.test',
    ]);
    await finiteTail(edge, tls.dir + '/facade-public-auth.sock', [
      'room:' + departureRoom.body.room_id,
    ]);
    // Assert the same status consumer on the selected finite prefix. A later
    // periodic auth publication may otherwise make live readiness false again
    // between its completion event and this read, without losing that fact.
    const initialScopes =
      (await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/status'))
        .body.result.scopes;
    for (
      const required of [
        'auth:@outside:logical.test',
        'auth:@departure:logical.test',
        'room:' + departureRoom.body.room_id,
      ]
    ) {
      assert(
        initialScopes.some((scope: { scope: string; ready: boolean }) =>
          scope.scope === required && scope.ready
        ),
      );
    }
    assertEquals((await api('facade', 'login')).body, {
      flows: [{ type: 'm.login.password' }],
    });
    const session = await api('facade', 'login', login());
    assertEquals(session.status, 200, JSON.stringify(session));
    assertEquals(session.body.device_id, 'public-device');
    for (const body of [{}, { display_name: 'foreign rename' }]) {
      assertEquals(
        await api(
          'facade',
          'devices/home-device',
          body,
          session.body.access_token,
          'PUT',
        ),
        {
          status: 503,
          body: {
            errcode: 'M_UNAVAILABLE',
            error: 'operation owner unavailable at this ingress',
          },
        },
      );
    }
    assertEquals(
      await api(
        'facade',
        'devices/home-device',
        undefined,
        session.body.access_token,
      ),
      {
        status: 200,
        body: { device_id: 'home-device', display_name: 'outside' },
      },
    );
    const deviceList = await api(
      'facade',
      'devices',
      undefined,
      session.body.access_token,
    );
    assertEquals(deviceList.status, 200);
    const whoisPath = 'admin/whois/%40outside%3Alogical.test';
    assertEquals(
      await api('facade', whoisPath, undefined, session.body.access_token),
      {
        status: 200,
        body: {
          user_id: '@outside:logical.test',
          devices: {
            'home-device': { sessions: [] },
            'public-device': { sessions: [{ connections: [] }] },
          },
        },
      },
    );
    assertEquals((await api('facade', whoisPath)).status, 401);
    assertEquals(
      (await api('facade', whoisPath, undefined, registered.body.access_token))
        .status,
      503,
    );
    assertEquals(
      (await api(
        'facade',
        'admin/whois/%40unknown%3Alogical.test',
        undefined,
        session.body.access_token,
      )).status,
      403,
    );
    assertEquals(
      deviceList.body.devices.map((device: { device_id: string }) =>
        device.device_id
      ),
      [
        'home-device',
        'public-device',
      ],
    );
    assertEquals(
      await api(
        'facade',
        'devices/public-device',
        {},
        session.body.access_token,
        'PUT',
      ),
      { status: 200, body: {} },
    );
    assertEquals(
      (await api(
        'facade',
        'devices/unknown',
        undefined,
        session.body.access_token,
      )).status,
      404,
    );
    // These reads use the ingress's existing authenticated adapters. Home is
    // stopped, and a supplied home-owned token must not bypass owner admission.
    const rtc = async (token?: string) => {
      const response = await fetch(
        `http://127.0.0.1:${facadePort}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`,
        { headers: token ? { authorization: 'Bearer ' + token } : {} },
      );
      return { status: response.status, body: await response.json() };
    };
    for (
      const [path, body] of [
        ['account/3pid', { threepids: [] }],
        ['thirdparty/protocols', {}],
        ['thirdparty/user?userid=%40outside%3Alogical.test', []],
        ['thirdparty/user/unknown', []],
        ['thirdparty/location?alias=%23unknown%3Alogical.test', []],
        ['thirdparty/location/unknown', []],
        ['voip/turnServer', {}],
      ] as const
    ) {
      assertEquals(
        await api('facade', path, undefined, session.body.access_token),
        {
          status: 200,
          body,
        },
        path,
      );
      assertEquals((await api('facade', path)).status, 401, path);
      assertEquals(
        (await api('facade', path, undefined, registered.body.access_token))
          .status,
        503,
        path,
      );
    }
    const discovery = await api(
      'facade',
      'capabilities',
      undefined,
      session.body.access_token,
    );
    assertEquals(discovery.status, 200);
    assertEquals(discovery.body.capabilities['m.change_password'], {
      enabled: false,
    });
    assertEquals(discovery.body.capabilities['m.profile_fields'], {
      enabled: true,
    });
    assertEquals((await api('facade', 'capabilities')).status, 401);
    assertEquals(
      (await api(
        'facade',
        'capabilities',
        undefined,
        registered.body.access_token,
      )).status,
      503,
    );
    assertEquals(await rtc(session.body.access_token), {
      status: 200,
      body: {},
    });
    assertEquals((await rtc()).status, 401);
    assertEquals((await rtc(registered.body.access_token)).status, 503);
    assertEquals(
      (await api(
        'facade',
        'thirdparty/protocol/unknown',
        undefined,
        session.body.access_token,
      )).body.errcode,
      'M_NOT_FOUND',
    );
    for (const path of ['thirdparty/user', 'thirdparty/location']) {
      assertEquals(
        (await api('facade', path, undefined, session.body.access_token))
          .status,
        400,
      );
    }
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
    timings.phase('offline push and saved notifications');
    const joined = await api(
      'facade',
      'joined_rooms',
      undefined,
      session.body.access_token,
    );
    assertEquals(joined, {
      status: 200,
      body: { joined_rooms: [departureRoom.body.room_id] },
    });
    const userSearch = await api('facade', 'user_directory/search', {
      search_term: 'departure',
    }, session.body.access_token);
    assertEquals(userSearch.status, 200);
    assertEquals(
      userSearch.body.results.map((user: { user_id: string }) => user.user_id),
      ['@departure:logical.test'],
    );
    assertEquals(userSearch.body.limited, false);
    for (
      const [path, body] of [['joined_rooms', undefined], [
        'user_directory/search',
        { search_term: 'departure' },
      ]] as const
    ) {
      assertEquals((await api('facade', path, body)).status, 401);
      assertEquals(
        (await api('facade', path, body, registered.body.access_token)).status,
        503,
      );
    }
    await finiteTail(edge, tls.dir + '/facade-public-auth.sock', [
      'domain:@outside:logical.test',
      'domain:@departure:logical.test',
    ]);
    const importedHistory = await api(
      'facade',
      'notifications',
      undefined,
      session.body.access_token,
    );
    assertEquals(importedHistory.status, 200);
    const importedNotices = importedHistory.body.notifications.filter((
      item: { event: { event_id: string } },
    ) => item.event.event_id === legacyNotice.body.event_id);
    assertEquals(
      importedNotices.length,
      1,
      'cold facade lost signed saved notification history',
    );
    assertEquals(importedNotices[0].event.content, legacyCiphertext);
    for (
      const [path, body] of [['notifications', undefined], [
        'pushers',
        undefined,
      ], ['pushers/set', {}]] as const
    ) {
      assertEquals(
        (await api('facade', path, body, registered.body.access_token)).status,
        503,
      );
      assertEquals((await api('facade', path, body, 'unknown')).status, 401);
    }
    const pushRegistration = {
      app_id: 'cold-app',
      pushkey: 'cold-key',
      kind: 'http',
      app_display_name: 'Cold app',
      device_display_name: 'Outside',
      lang: 'en',
      data: {
        url: `https://127.0.0.1:${gateway.addr.port}/_matrix/push/v1/notify`,
      },
    };
    assertEquals(
      await api(
        'facade',
        'pushers/set',
        pushRegistration,
        session.body.access_token,
      ),
      { status: 200, body: {} },
    );
    assertEquals(
      await api('facade', 'pushers', undefined, session.body.access_token),
      { status: 200, body: { pushers: [pushRegistration] } },
    );
    const senderSession = await api('facade', 'login', {
      ...login('push-sender-edge'),
      identifier: { type: 'm.id.user', user: 'departure' },
    });
    assertEquals(senderSession.status, 200);
    const pushRoomPath = 'rooms/' +
      encodeURIComponent(departureRoom.body.room_id);
    assertEquals(
      (await api(
        'facade',
        pushRoomPath + '/join',
        {},
        session.body.access_token,
      )).status,
      200,
    );
    const ciphertext = {
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'cold-push-ciphertext',
      session_id: 'cold-session',
    };
    const pushed = await api(
      'facade',
      pushRoomPath + '/send/m.room.encrypted/cold-push',
      ciphertext,
      senderSession.body.access_token,
      'PUT',
    );
    assertEquals(pushed.status, 200);
    const wire = await delivered(pushed.body.event_id);
    assertEquals(wire.content, ciphertext);
    assertEquals(
      (wire.devices as Record<string, unknown>[]).map((device) =>
        device.pushkey
      ),
      ['cold-key'],
    );
    const history = await api(
      'facade',
      'notifications',
      undefined,
      session.body.access_token,
    );
    assertEquals(history.status, 200, JSON.stringify(history));
    const saved = history.body.notifications.find((
      item: { event: { event_id: string } },
    ) => item.event.event_id === pushed.body.event_id);
    assert(saved);
    assertEquals(saved.read, false);
    assertEquals(saved.event.content, ciphertext);
    assertEquals(saved.event.room_id, undefined);
    assertEquals(saved.event.signatures, undefined);
    const mute = 'pushrules/global/override/cold-mute';
    assertEquals(
      (await api(
        'facade',
        mute,
        { conditions: [], actions: ['dont_notify'] },
        session.body.access_token,
        'PUT',
      )).status,
      200,
    );
    const silent = await api(
      'facade',
      pushRoomPath + '/send/m.room.encrypted/cold-muted',
      ciphertext,
      senderSession.body.access_token,
      'PUT',
    );
    assertEquals(silent.status, 200);
    timings.phase('offline native delayed owner and cold disabled scheduling');
    const management = '../unstable/org.matrix.msc4140/delayed_events';
    const waitDelayedState = async (key: string, marker: string) => {
      let result;
      const deadline = Date.now() + 10000;
      do {
        result = await api(
          'facade',
          pushRoomPath + '/state/test.delayed/' + key,
          undefined,
          senderSession.body.access_token,
        );
        if (result.status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assertEquals(result, { status: 200, body: { marker } });
    };
    const delayPath = pushRoomPath + '/send/m.room.encrypted/cold-delay';
    const delayed = await api(
      'facade',
      delayPath + '?org.matrix.msc4140.delay=60000',
      { ...ciphertext, ciphertext: 'cold-delayed-ciphertext' },
      senderSession.body.access_token,
      'PUT',
    );
    assertEquals(delayed.status, 200, JSON.stringify(delayed));
    assertEquals(delayed.body.event_id, undefined);
    const delayId = delayed.body.delay_id;
    assertEquals(
      (await api(
        'facade',
        delayPath + '?org.matrix.msc4140.delay=60000',
        { ignored: 'stable receipt' },
        senderSession.body.access_token,
        'PUT',
      )).body,
      delayed.body,
    );
    const listedDelay = await api(
      'facade',
      management,
      undefined,
      senderSession.body.access_token,
    );
    assertEquals(listedDelay.status, 200);
    assertEquals(
      listedDelay.body.delayed_events.filter((item: { delay_id: string }) =>
        item.delay_id === delayId
      ).length,
      1,
    );
    assertEquals(
      (await api(
        'facade',
        management + '/' + delayId,
        undefined,
        session.body.access_token,
      )).status,
      404,
    );
    assertEquals(
      (await api(
        'facade',
        management + '/' + delayId + '/restart',
        {},
        registered.body.access_token,
      )).status,
      503,
    );
    assertEquals(
      (await api('facade', management + '/legacy-home-id', { action: 'send' }))
        .status,
      503,
    );
    assertEquals(
      (await api('facade', management + '/' + delayId + '/restart', {})).status,
      200,
    );
    const cancelled = await api(
      'facade',
      pushRoomPath +
        '/state/test.delayed/cancelled?org.matrix.msc4140.delay=60000',
      { marker: 'must-not-run' },
      senderSession.body.access_token,
      'PUT',
    );
    assertEquals(cancelled.status, 200);
    assertEquals(
      (await api(
        'facade',
        management + '/' + cancelled.body.delay_id + '/cancel',
        {},
      )).status,
      200,
    );
    const dueWhileStopped = await api(
      'facade',
      pushRoomPath + '/state/test.delayed/cold?org.matrix.msc4140.delay=2000',
      { marker: 'cold-with-new-scheduling-disabled' },
      senderSession.body.access_token,
      'PUT',
    );
    assertEquals(dueWhileStopped.status, 200);
    await edge.stop();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await configure('facade', '', 0, true);
    edge = await process(file('facade'), 'facade: link/local admin ready');
    assertEquals(
      await api(
        'facade',
        'voip/turnServer',
        undefined,
        session.body.access_token,
      ),
      {
        status: 200,
        body: {
          uris: ['turn:ingress.test:3478'],
          username: 'ingress-user',
          password: 'ingress-test-password',
          ttl: 600,
        },
      },
    );
    assertEquals(await rtc(session.body.access_token), {
      status: 200,
      body: {
        rtc_transports: [{
          type: 'livekit',
          livekit_service_url: 'https://rtc.ingress.test/',
        }],
      },
    });
    await waitDelayedState('cold', 'cold-with-new-scheduling-disabled');
    assertEquals(
      (await api(
        'facade',
        pushRoomPath + '/state/test.delayed/cancelled',
        undefined,
        senderSession.body.access_token,
      )).status,
      404,
    );
    assertEquals(
      (await api(
        'facade',
        management + '/' + delayId,
        undefined,
        senderSession.body.access_token,
      )).body.content.ciphertext,
      'cold-delayed-ciphertext',
    );
    assertEquals(
      (await api(
        'facade',
        delayPath + '-disabled?org.matrix.msc4140.delay=1',
        ciphertext,
        senderSession.body.access_token,
        'PUT',
      )).status,
      403,
    );
    assertEquals(
      (await api('facade', management + '/' + delayId, { action: 'send' }))
        .status,
      200,
    );
    const delayedMessages = await api(
      'facade',
      pushRoomPath + '/messages?dir=b&limit=100',
      undefined,
      session.body.access_token,
    );
    assertEquals(delayedMessages.status, 200);
    const delayedVisible = delayedMessages.body.chunk.filter((
      item: { content: { ciphertext?: string } },
    ) => item.content.ciphertext === 'cold-delayed-ciphertext');
    assertEquals(
      delayedVisible.length,
      1,
      'delayed command did not reach the actual room consumer exactly once',
    );
    assertEquals(
      (await api('facade', management + '/' + delayId + '/send', {})).status,
      404,
    );
    await edge.stop();
    await configure('facade');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    const automatic = await api(
      'facade',
      pushRoomPath + '/state/test.delayed/automatic?org.matrix.msc4140.delay=0',
      { marker: 'automatic-after-bind' },
      senderSession.body.access_token,
      'PUT',
    );
    assertEquals(automatic.status, 200, JSON.stringify(automatic));
    await waitDelayedState('automatic', 'automatic-after-bind');
    assertEquals(
      (await api(
        'facade',
        delayPath + '?org.matrix.msc4140.delay=60000',
        ciphertext,
        senderSession.body.access_token,
        'PUT',
      )).body,
      delayed.body,
    );
    const restoredHistory = await api(
      'facade',
      'notifications',
      undefined,
      session.body.access_token,
    );
    assertEquals(restoredHistory.status, 200);
    const restored = restoredHistory.body.notifications.filter((
      item: { event: { event_id: string } },
    ) => item.event.event_id === pushed.body.event_id);
    assertEquals(restored.length, 1);
    assertEquals({
      actions: restored[0].actions,
      read: restored[0].read,
      ts: restored[0].ts,
      content: restored[0].event.content,
    }, {
      actions: saved.actions,
      read: saved.read,
      ts: saved.ts,
      content: saved.event.content,
    });
    assertEquals(
      restoredHistory.body.notifications.some((
        item: { event: { event_id: string } },
      ) => item.event.event_id === silent.body.event_id),
      false,
    );
    assertEquals(
      (await api(
        'facade',
        pushRoomPath + '/receipt/m.read.private/' +
          encodeURIComponent(pushed.body.event_id),
        {},
        session.body.access_token,
      )).status,
      200,
    );
    const readHistory = await api(
      'facade',
      'notifications',
      undefined,
      session.body.access_token,
    );
    assertEquals(
      readHistory.body.notifications.find((
        item: { event: { event_id: string } },
      ) => item.event.event_id === pushed.body.event_id).read,
      true,
    );
    assertEquals(
      await api('facade', 'pushers/set', {
        app_id: 'cold-app',
        pushkey: 'cold-key',
        kind: null,
      }, session.body.access_token),
      { status: 200, body: {} },
    );
    assertEquals(
      await api('facade', 'pushers', undefined, session.body.access_token),
      { status: 200, body: { pushers: [] } },
    );
    assertEquals(
      (await api(
        'facade',
        mute,
        undefined,
        session.body.access_token,
        'DELETE',
      )).status,
      200,
    );
    // Leave the pre-existing deactivation proof's original membership unchanged.
    assertEquals(
      (await api(
        'facade',
        pushRoomPath + '/leave',
        {},
        session.body.access_token,
      )).status,
      200,
    );
    const toDevicePath = 'sendToDevice/m.room_key_request/public-owner-send';
    const originalRequest = {
      messages: {
        '@outside:logical.test': { '*': { request_id: 'public-owner-send' } },
      },
    };
    assertEquals(
      (await api(
        'facade',
        toDevicePath,
        originalRequest,
        session.body.access_token,
        'PUT',
      )).status,
      200,
    );
    assertEquals(
      (await api(
        'facade',
        toDevicePath,
        {
          messages: {
            '@outside:logical.test': {
              '*': { request_id: 'must-not-replace' },
            },
          },
        },
        session.body.access_token,
        'PUT',
      )).status,
      200,
    );
    assertEquals(
      (await api(
        'facade',
        toDevicePath + '-wrong',
        originalRequest,
        registered.body.access_token,
        'PUT',
      )).status,
      503,
    );
    const rotated = await api('facade', 'refresh', {
      refresh_token: session.body.refresh_token,
    });
    assertEquals(rotated.status, 200);
    await edge.stop();
    const sentStore = await openStore({
      dir: tls.dir + '/facade-public-auth-store',
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
    });
    try {
      const savedServer = await sentStore.server();
      const sourceFacts = await savedServer.query(
        "SELECT payload_json FROM domain_operations WHERE kind='notification' AND source='home' AND json_extract(payload_json,'$.user')='@outside:logical.test' AND json_extract(payload_json,'$.event')=?",
        [legacyNotice.body.event_id],
      );
      assertEquals(
        sourceFacts.length,
        1,
        'cold public reader has no retained original home context',
      );
      const originalFact = JSON.parse(String(sourceFacts[0].payload_json));
      assertEquals(originalFact.createdMs, originalNotice.ts);
      assertEquals(originalFact.actions, originalNotice.actions);
      const db = await sentStore.tenant('logical.test');
      assertEquals(
        (await db.query(
          'SELECT * FROM to_device_transactions WHERE txn_id LIKE ?',
          ['public-owner-send%'],
        )).length,
        1,
      );
      const received = await db.query(
        'SELECT event_json FROM to_device_inbox WHERE localpart=? AND device_id=?',
        ['outside', 'public-device'],
      );
      assertEquals(
        received.map((row) => JSON.parse(String(row.event_json)).content),
        [{ request_id: 'public-owner-send' }],
      );
      assertEquals(await db.query('SELECT * FROM to_device_intents'), []);
    } finally {
      await sentStore.close();
    }
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
    await home.listening(homePort);
    assertEquals((await api('home', 'login')).status, 200);
    await edge.observations.wait((event) =>
      event.kind === 'health' && event.pairing === pairing &&
      event.stream === 'auth:@outside:logical.test' && event.online
    );
    // Keep the live connection, but fence the next source page before it can
    // declare or deliver a newer auth cut. Strict admission requires a complete
    // received prefix, not merely a previously completed reconciliation.
    const strictPublication = await home.holdPublication(
      'stream:auth:@outside:logical.test',
    );
    try {
      await strictPublication.held();
      await finiteTail(edge, tls.dir + '/facade-public-auth.sock', [
        'auth:@outside:logical.test',
      ]);
      assertEquals(
        (await api(
          'facade',
          'login',
          login('online-strict-device'),
        )).status,
        200,
      );
    } finally {
      await strictPublication.release();
    }
    const connectedMark = edge.observations.mark();
    await home.stop();
    await edge.observations.wait(
      (event) =>
        event.kind === 'health' && event.pairing === pairing && !event.online,
      connectedMark,
    );
    assertEquals(
      (await api(
        'facade',
        'login',
        login('offline-strict-probe', 'not-the-password'),
      )).status,
      503,
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
    await home.listening(homePort);
    assertEquals((await api('home', 'login')).status, 200);
    assertEquals(
      await api('facade', 'login', login('still-disabled')),
      unavailable,
    );
    assertEquals((await api('facade', 'register', {})).status, 503);
    assertEquals(
      (await api('facade', 'createRoom', {}, retried.body.access_token)).status,
      200,
    );
    await edge.stop();
    await configure('facade');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    // Home controls verifier export independently of the facade's local setting.
    await home.stop();
    await configure('home', 'replicatecredentials=false\n');
    home = await process(file('home'), 'federation: disabled');
    await home.listening(homePort);
    assertEquals((await api('home', 'login')).status, 200);
    // Observe capability withdrawal without issuing new sessions while waiting.
    // A successful login is a mutation and feeds the account replication loop.
    for (const localpart of ['outside', 'departure']) {
      await homeFact(
        edge,
        pairing,
        'auth:@' + localpart + ':logical.test',
        (record) =>
          !authView(record).credentials && authView(record).phc === null,
      );
    }
    assertEquals((await api('facade', 'login')).body.flows.length, 0);
    assertEquals(
      await api('facade', 'login', login('home-kept-verifier')),
      unavailable,
    );
    await home.stop();
    // The source's cancelled request can leave an admitted receive callback at
    // the facade. Its graceful close joins those handlers; a cold reopen then
    // has a genuinely finite received prefix, not a moving status capture.
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await authTail(['outside', 'departure']);
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        retried.body.access_token,
      )).status,
      200,
    );
    assertEquals((await api('facade', 'login')).body.flows.length, 0);
    assertEquals(
      await api('facade', 'login', login('home-kept-verifier')),
      unavailable,
    );
    assertEquals((await api('facade', 'login')).body, { flows: [] });
    const restoreMark = edge.observations.mark();
    await configure('home');
    home = await process(file('home'), 'federation: disabled');
    await home.listening(homePort);
    assertEquals((await api('home', 'login')).status, 200);
    for (const localpart of ['outside', 'departure']) {
      await homeFact(
        edge,
        pairing,
        'auth:@' + localpart + ':logical.test',
        (record) =>
          authView(record).credentials && authView(record).phc !== null,
        restoreMark,
      );
    }
    assertEquals(
      (await api('facade', 'login', login('verifier-restored'))).status,
      200,
    );
    await home.stop();
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await authTail(['outside', 'departure']);
    assertEquals(
      (await api(
        'facade',
        'account/whoami',
        undefined,
        retried.body.access_token,
      )).status,
      200,
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
    await home.listening(homePort);
    const edgeIncarnation =
      (await adminCall(tls.dir + '/facade-public-auth.sock', 'facade/status'))
        .body.result.incarnation;
    const edgeIdentity = {
      peer: 'edge_a',
      source: 'edge_a',
      incarnation: edgeIncarnation,
      stream: 'authority:@outside:logical.test',
    };
    await home.observations.fact(
      edgeIdentity,
      (record) =>
        authorityView(record).authority.facts.some((fact) =>
          fact.kind === 'delete' && fact.deviceId === 'home-device'
        ),
    );
    assertEquals(
      (await api(
        'home',
        'account/whoami',
        undefined,
        registered.body.access_token,
      )).status,
      401,
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
    await homeFact(
      edge,
      pairing,
      'auth:@outside:logical.test',
      (record) =>
        authView(record).deactivated &&
        authView(record).authority.facts.some((fact) =>
          fact.kind === 'deactivate'
        ),
    );
    assertEquals(
      (await api(
        'facade',
        'login',
        login('after-deactivation'),
      )).body
        .errcode,
      'M_FORBIDDEN',
    );
    timings.phase('home deactivation shutdown');
    await home.stop();
    // Home shutdown can finish after another capture was received but before
    // its independent facade owner commits the apply/result. Drain that cut.
    timings.phase('facade drains deactivation tail offline');
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    await authTail(['outside']);
    assertEquals(
      (await api(
        'facade',
        'login',
        login('offline-deactivated', 'not-the-password'),
      )).body
        .errcode,
      'M_FORBIDDEN',
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
    assertEquals(
      (await api('facade', 'login', {
        ...departureLogin,
        password: 'not-the-password',
      })).status,
      403,
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
    await home.listening(homePort);
    await home.observations.fact(
      { ...edgeIdentity, stream: 'authority:@departure:logical.test' },
      (record) =>
        authorityView(record).authority.facts.some((fact) =>
          fact.kind === 'deactivate'
        ),
    );
    assertEquals(
      (await api('home', 'login', departureLogin)).body.errcode,
      'M_FORBIDDEN',
    );
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
    await gateway.shutdown();
    await tls.close();
  }
});

function homeFact(
  child: Awaited<ReturnType<typeof process>>,
  pairing: string,
  stream: string,
  matches: (record: LinkRecord) => boolean,
  after = 0,
) {
  return child.observations.fact(
    { peer: 'home', source: 'home', incarnation: pairing, stream },
    matches,
    after,
  );
}

function authView(record: LinkRecord): AccountAuth {
  return object(object(record.payload).signed).body as AccountAuth;
}

function authorityView(
  record: LinkRecord,
): { authority: AccountAuth['authority'] } {
  return object(record.payload).body as { authority: AccountAuth['authority'] };
}

function toDeviceView(record: LinkRecord): ToDeviceOperation {
  return object(object(record.payload).body).operation as ToDeviceOperation;
}

function roomView(record: LinkRecord): ReplicaRoom {
  return object(record.payload).manifest as ReplicaRoom;
}

async function finiteTail(
  child: Awaited<ReturnType<typeof process>>,
  socket: string,
  scopes: string[],
) {
  const applied = await finiteStreams(child, socket, scopes);
  for (const scope of scopes) {
    const held = applied.scopes.find((row: { scope: string }) =>
      row.scope === scope
    );
    assert(held?.ready && held.pending === null);
  }
}

async function finiteStreams(
  child: Awaited<ReturnType<typeof process>>,
  socket: string,
  scopes: string[],
) {
  const state = (await adminCall(socket, 'facade/status')).body.result;
  const streams = scopes.map((scope) => {
    const stream = state.streams.find((row: { stream: string }) =>
      row.stream === scope
    );
    assert(stream, 'required finite tail is absent: ' + scope);
    return stream;
  });
  await child.observations.tail('home', streams);
  const applied = (await adminCall(socket, 'facade/status')).body.result;
  for (const scope of scopes) {
    const stream = applied.streams.find((row: { stream: string }) =>
      row.stream === scope
    );
    assertEquals(stream.received, stream.applied);
  }
  return applied;
}
