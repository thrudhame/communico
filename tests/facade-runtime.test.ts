import { assert, assertEquals, assertRejects } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };
import { adminCall } from './admin-client.ts';
import { bounded, pause } from './helpers/server-process.ts';
import { facadeTls } from './support/facade-tls.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';

Deno.test('cold roles enroll through local admin without facade tenant genesis, Matrix or home workers', async () => {
  const tls = await facadeTls();
  const ports = [];
  for (let i = 0; i < 3; i++) {
    const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    ports.push(probe.addr.port);
    probe.close();
  }
  const [facadePort, homePort, linkPort] = ports;
  const facadeConfig = `${tls.dir}/facade.toml`;
  const homeConfig = `${tls.dir}/home.toml`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const common = (side: string, port: number, role: string) =>
    `[server]\nname="logical.test"\nrole="${role}"\nport=${port}\n[store]\ndir="${tls.dir}/${side}-store"\n[media]\nroot="${tls.dir}/${side}-media"\n[admin]\nsocket="${tls.dir}/${side}.sock"\n`;
  const link = (side: string) =>
    `[facade]\nnodeid="edge_a"\nurl="https://127.0.0.1:${linkPort}"\nlinkport=${linkPort}\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n`;
  await Deno.writeTextFile(
    facadeConfig,
    common('facade', facadePort, 'facade') + '[federation]\nenabled=true\n' +
      link('facade'),
  );
  await Deno.writeTextFile(
    homeConfig,
    common('home', homePort, 'home') + '[federation]\nenabled=false\n' +
      link('home') + `nodes=["edge_a"]\npairfile="${bundlefile}"\n`,
  );
  let facade: Awaited<ReturnType<typeof process>> | undefined;
  let home: Awaited<ReturnType<typeof process>> | undefined;
  try {
    facade = await process(facadeConfig, 'facade: link/local admin ready');
    const status = () => adminCall(tls.dir + '/facade.sock', 'facade/status');
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
    home = await process(homeConfig, 'federation: disabled');
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
      { name: 'Home-owned replica' },
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
    assertEquals((await status()).body.result.matrix, false);
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
    await assertRejects(() =>
      Deno.connect({ hostname: '127.0.0.1', port: facadePort })
    );
    assertEquals(
      await Deno.stat(tls.dir + '/facade-media').catch(() => null),
      null,
    );
    // Completed authority must not require the old one-time plaintext bundle.
    await Deno.remove(bundlefile);
    await Deno.writeTextFile(
      facadeConfig,
      common('facade', facadePort, 'facade') + '[federation]\nenabled=true\n' +
        link('facade') + `pairfile="${bundlefile}"\n`,
    );
    await facade.stop();
    facade = await process(facadeConfig, 'facade: link/local admin ready');
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
    home = await process(homeConfig, 'federation: disabled');
    await adminCall(tls.dir + '/home.sock', 'facade/revoke', {
      id: paired.body.result.id,
    });
    await until(async () => (await status()).body.result.enrolled === false);
    await home.stop();
    home = undefined;
    await facade.stop();
    facade = undefined;
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
      if (ended) return;
      child.kill('SIGTERM');
      const status = await bounded(output);
      assertEquals(status.code, 0, out + '\n' + err);
      assert(out.includes('shutdown: store closed'));
    },
    dispose,
  };
}
