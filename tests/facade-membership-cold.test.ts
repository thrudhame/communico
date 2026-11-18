import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { FacadeKeys } from '#engine/facade/control.ts';
import { enrolledTenant, loadNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { type LinkRecord, object } from '#engine/facade/protocol.ts';
import { invitesOf, receiveInvite } from '#engine/federation/invites.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { adminCall } from './admin-client.ts';
import { seedServer } from './federation/doc-helper.ts';
import { fakeKeyResolver, remoteEvent } from './fixtures/remote.ts';
import { testRemoteServer } from './fixtures/signer.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('membership cold composition: empty bootstrap and independent local invites cross the real home-initiated link in both directions', async () => {
  const tls = await facadeTls();
  const ports: number[] = [];
  for (let i = 0; i < 3; i++) {
    const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    ports.push(probe.addr.port);
    probe.close();
  }
  const [homePort, edgePort, linkPort] = ports;
  const file = (side: string) => tls.dir + '/' + side + '.toml';
  const socket = (side: string) => tls.dir + '/' + side + '.sock';
  const bundlefile = tls.dir + '/bundle.json';
  for (
    const [side, role, port] of [['home', 'home', homePort], [
      'facade',
      'facade',
      edgePort,
    ]] as const
  ) {
    await Deno.writeTextFile(
      file(side),
      `[server]\nname="logical.test"\nrole="${role}"\nport=${port}\n` +
        `[store]\ndir="${tls.dir}/${side}-store"\n[media]\nroot="${tls.dir}/${side}-media"\n` +
        `[admin]\nsocket="${socket(side)}"\n[federation]\nenabled=false\n` +
        `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:${linkPort}"\nlinkport=${linkPort}\n` +
        `linkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\n` +
        'pollseconds=1\nreconnectmaxseconds=1\n' +
        (side === 'home' ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n` : ''),
    );
  }
  const api = async (
    port: number,
    path: string,
    body?: unknown,
    token?: string,
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/_matrix/client/v3/${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const open = (side: string) =>
    openStore({
      dir: tls.dir + '/' + side + '-store',
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    });
  let home: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  let edge: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  const user = '@pending:logical.test';
  try {
    edge = await facadeProcess(
      file('facade'),
      'facade: link/local admin ready',
    );
    assertEquals(
      (await adminCall(socket('facade'), 'facade/initialize')).status,
      200,
    );
    home = await facadeProcess(file('home'), 'federation: disabled');
    await home.listening(homePort);
    let homeToken = '';
    for (const username of ['empty', 'pending']) {
      const input = { username, password: 'runtime-password' };
      const challenge = await api(homePort, 'register', input);
      const result = await api(homePort, 'register', {
        ...input,
        auth: { type: 'm.login.dummy', session: challenge.body.session },
      });
      assertEquals(result.status, 200);
      if (username === 'pending') homeToken = result.body.access_token;
    }
    const pair = await adminCall(socket('home'), 'facade/pair', {
      node: 'edge_a',
      url: `https://127.0.0.1:${linkPort}`,
      facadePin: tls.facadePin,
      expires: Date.now() + 60000,
      bundlefile,
    });
    assertEquals(pair.status, 200);
    const pairing = String(pair.body.result.id);
    assertEquals(
      (await adminCall(socket('facade'), 'facade/accept', { bundlefile }))
        .status,
      200,
    );
    const homeFact = (
      child: NonNullable<typeof edge>,
      stream: string,
      matches: (record: LinkRecord) => boolean = () => true,
    ) =>
      child.observations.fact({
        peer: 'home',
        source: 'home',
        incarnation: pairing,
        stream,
      }, matches);
    // No manual MembershipOperations bootstrap or directory export supplies this
    // proof. The normal home composition must independently declare both zeros.
    await homeFact(edge, 'directory', (record) => {
      const view = object(object(record.payload).view),
        cuts = object(view.cuts);
      return record.version === 2 &&
        cuts['membership:@empty:logical.test'] === 0 &&
        cuts['membership:' + user] === 0;
    });
    for (const localpart of ['empty', 'pending']) {
      await homeFact(edge, 'auth:@' + localpart + ':logical.test');
      await homeFact(edge, 'domain:@' + localpart + ':logical.test');
    }
    await edge.listening(edgePort);
    await home.stop();
    await edge.stop();
    const remote = await testRemoteServer('remote.test');
    const expected = new Map<string, string>();
    let edgeIncarnation = '';
    for (const side of ['home', 'facade'] as const) {
      const store = await open(side);
      try {
        const server = await store.server();
        await seedServer(server, remote);
        let tenant, signer;
        if (side === 'home') {
          tenant = await openTenant(store, 'logical.test');
          signer = tenant.signer();
        } else {
          const node = await loadNode(server, 'logical.test', 'edge_a');
          edgeIncarnation = node.incarnation;
          const pairings = new Pairings(
            server,
            node.signer(),
            node.publicKey,
            tls.facadePin,
            node,
          );
          tenant = await enrolledTenant(
            store,
            pairings,
            'logical.test',
            'edge_a',
          );
          signer = await new FacadeKeys(
            server,
            node.signer(),
            node.publicKey,
            pairings,
          ).requestSigner();
        }
        const roomId = '!cold-' + side + ':remote.test';
        const pdu = await remoteEvent(roomId, remote, '11', {
          type: 'm.room.member',
          sender: '@inviter:remote.test',
          state_key: user,
          content: {
            membership: 'invite',
            reason: side + '-while-processes-down',
          },
          prev_events: [],
        });
        setConfigForTests({
          server: {
            name: 'logical.test',
            role: side === 'home' ? 'home' : 'facade',
          },
          facade: { phase: 'f2', nodeid: 'edge_a' },
        });
        await receiveInvite(
          roomId,
          String(pdu.event_id),
          {
            room_version: '11',
            event: pdu,
            invite_room_state: [],
          },
          remote.name,
          {
            store,
            server,
            self: 'logical.test',
            signer,
            keys: fakeKeyResolver(remote),
            wake() {},
          },
        );
        expected.set(roomId, String(pdu.event_id));
      } finally {
        await store.close();
      }
    }
    setConfigForTests({});
    edge = await facadeProcess(
      file('facade'),
      'facade: link/local admin ready',
    );
    home = await facadeProcess(file('home'), 'federation: disabled');
    await home.listening(homePort);
    const isFact = (roomId: string) => (record: LinkRecord) => {
      const operation = object(object(object(record.payload).body).operation);
      const state = object(JSON.parse(String(operation.payload)));
      return state.roomId === roomId && state.eventId === expected.get(roomId);
    };
    await homeFact(
      edge,
      'membership:' + user,
      isFact('!cold-home:remote.test'),
    );
    await home.observations.fact({
      peer: 'edge_a',
      source: 'edge_a',
      incarnation: edgeIncarnation,
      stream: 'membership:' + user,
    }, isFact('!cold-facade:remote.test'));
    // Quiesce the producer, then observe the exact finite received prefix. Later
    // directory/control records cannot race ordinary public-read readiness.
    await home.stop();
    const before =
      (await adminCall(socket('facade'), 'facade/status')).body.result;
    await edge.observations.tail('home', before.streams);
    await edge.listening(edgePort);
    const session = await api(edgePort, 'login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'pending' },
      password: 'runtime-password',
      device_id: 'COLD_EDGE',
    });
    assertEquals(session.status, 200, JSON.stringify(session));
    await edge.stop();
    // Public facade /sync is B9's route activation, not a B7 capability. The
    // production cold inbox has completed; inspect its ordinary invite reader.
    // Both sync renderers are independently exercised by membership-runtime.
    const received = await open('facade');
    try {
      const displayed = await invitesOf(user, {
        server: await received.server(),
      });
      assertEquals(
        displayed.map((invite) => [invite.roomId, invite.eventId]).sort(),
        [...expected].sort(),
      );
    } finally {
      await received.close();
    }
    home = await facadeProcess(file('home'), 'federation: disabled');
    await home.listening(homePort);
    const homeSync = await api(
      homePort,
      'sync?timeout=0',
      undefined,
      homeToken,
    );
    assertEquals(homeSync.status, 200, JSON.stringify(homeSync));
    assertEquals(
      Object.keys(homeSync.body.rooms.invite).sort(),
      [...expected.keys()].sort(),
    );
    await home.stop();
    for (const side of ['home', 'facade']) {
      const store = await open(side);
      try {
        assertEquals(
          await (await store.server()).query('SELECT * FROM prejoin_jobs'),
          [],
        );
        assertEquals(await store.rooms(), []);
      } finally {
        await store.close();
      }
    }
  } finally {
    await home?.dispose();
    await edge?.dispose();
    setConfigForTests({});
    await tls.close();
  }
});
