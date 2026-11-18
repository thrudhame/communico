import { assert, assertEquals, assertRejects } from '@std/assert';
import { closeApp, openReplicaApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseStreamToken } from '#engine/client/tokens.ts';
import { syncFor } from '#engine/syncfeed.ts';
import { slidingSync } from '#engine/sliding-sync/index.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { DEFAULT_ROOM_FILTER } from '#engine/tenant/filters.ts';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import { exportKeyRoster, FacadeKeys } from '#engine/facade/control.ts';
import { DomainOperations } from '#engine/facade/domain.ts';
import {
  DirectoryReplicas,
  exportDirectoryReplica,
} from '#engine/facade/directory.ts';
import { bindRole } from '#engine/facade/role.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { MembershipOperations } from '#engine/facade/membership.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  type LinkRecord,
} from '#engine/facade/protocol.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import {
  invitesOf,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { knockRemote } from '#engine/federation/knocks.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { fakeKeyResolver, remoteEvent } from './fixtures/remote.ts';
import type { Pdu } from '#engine/pdu.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { seedServer } from './federation/doc-helper.ts';
import { facadeTls } from './support/facade-tls.ts';

// The production inbox, not a directly called membership adapter, owns apply.
// Retain its exact completion without a wall-clock readiness assertion.
async function membershipRuntime(kind: 'invite' | 'knock') {
  const tls = await facadeTls();
  const settings = (side: string) => ({
    dir: tls.dir + '/' + side + '-store',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const schemas = {
    server: serverSchema,
    tenant: tenantSchema,
    room: roomSchema,
  };
  const home = await openStore(settings('home'), { schemas });
  const edge = await openStore(settings('edge'), { schemas });
  let runtime: Awaited<ReturnType<typeof openFacadeRuntime>> | undefined;
  let appBound = false;
  let remote: Awaited<ReturnType<typeof startFakeServer>> | undefined;
  let localRemote: Awaited<ReturnType<typeof startFakeServer>> | undefined;
  const releaseLocalLeave = Promise.withResolvers<void>();
  try {
    await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
    await bindRole(edge, {
      role: 'facade',
      server: 'logical.test',
      node: 'edge_a',
    });
    const ht = await openTenant(home, 'logical.test', { create: true });
    await ht.tx((tx) => tx.users.insert('alice', 'Alice'));
    const node = await initializeNode(
      await edge.server(),
      'logical.test',
      'edge_a',
    );
    const hp = new Pairings(
      await home.server(),
      ht.signer(),
      ht.publicB64,
      tls.homePin,
    );
    const fp = new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      tls.facadePin,
      node,
    );
    const url = 'https://127.0.0.1:8448';
    const bundle = await hp.create({
      node: 'edge_a',
      url,
      facadePin: tls.facadePin,
      expires: Date.now() + 60000,
      required: [...LINK_CAPABILITIES],
    });
    await fp.accept(bundle);
    await hp.confirm(
      bundle.id,
      await fp.complete(
        bundle.id,
        await hp.grant(
          bundle.id,
          await fp.challenge(bundle.id, bundle.secret, tls.homePin),
        ),
        tls.homePin,
      ),
    );
    const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
    const journal = new Journal(await edge.server(), LINK_SUPPORTED);
    const keyOwner = new FacadeKeys(
      await edge.server(),
      node.signer(),
      node.publicKey,
      fp,
    );
    const roster = await exportKeyRoster(
      home,
      ht,
      node.node,
      bundle.id,
      (_id, doc) => keyOwner.cosign(doc),
    );
    assert(roster);
    await journal.receive('home', [roster]);
    await keyOwner.apply(journal, roster);
    const controls = new OwnerControls(
      await edge.server(),
      await edge.tenant('logical.test'),
      fp,
      node,
    );
    const control = await exportOwnerControl(home, ht, hp, bundle.id);
    await journal.receive('home', [control]);
    await controls.apply(journal, control);
    const auth = await exportAccountAuth(
      home,
      ht,
      hp,
      bundle.id,
      'alice',
      false,
    );
    await journal.receive('home', [auth]);
    await new AccountSnapshots(edge, et, fp, controls).apply(journal, auth);
    // Ordinary sync reads the account-data owner as well as membership. Install
    // its real selected-account bootstrap, never bypass the runtime auth gate.
    const domainOwner = new DomainOperations(edge, et, fp, node);
    for (
      const domain of await new DomainOperations(home, ht, hp).bootstrap(
        'alice',
        bundle.id,
      )
    ) {
      await journal.receive('home', [domain]);
      await domainOwner.apply(journal, domain);
    }
    const roomId = '!runtime-' + kind + ':remote.test',
      userId = '@alice:logical.test';
    let sentKnock: Pdu | undefined;
    remote = await startFakeServer({
      ourKeyDoc: () =>
        Promise.resolve({
          server_name: 'logical.test',
          verify_keys: { [ht.keyId]: { key: ht.publicB64 } },
        }),
      handlers: (request) => {
        if (request.url.pathname.includes('/make_knock/')) {
          assert(request.verified);
          return Response.json({
            room_version: '11',
            event: {
              type: 'm.room.member',
              room_id: roomId,
              sender: userId,
              state_key: userId,
              content: { membership: 'knock' },
              prev_events: [],
              auth_events: [],
              depth: 1,
            },
          });
        }
        if (request.url.pathname.includes('/send_knock/')) {
          assert(request.verified);
          sentKnock = request.json() as Pdu;
          return Response.json({ knock_room_state: [] });
        }
        return null;
      },
    });
    await seedServer(await edge.server(), remote);
    const deps = {
      store: home,
      server: await home.server(),
      self: 'logical.test',
      signer: ht.signer(),
      keys: fakeKeyResolver(remote),
      wake() {},
    };
    let pdu: Pdu;
    if (kind === 'invite') {
      pdu = await remoteEvent(roomId, remote, '11', {
        type: 'm.room.member',
        sender: '@inviter:' + remote.name,
        state_key: userId,
        content: { membership: 'invite' },
        prev_events: [],
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
        deps,
      );
    } else {
      setConfigForTests({
        server: { name: 'logical.test' },
        federation: {
          enabled: true,
          cacerts: ['tests/fixtures/tls/ca.crt'],
        },
      });
      resetCaCertsForTests();
      const knocked = await knockRemote(
        roomId,
        userId,
        { reason: 'runtime knock' },
        [remote.name],
        deps,
      );
      assertEquals(knocked.roomId, roomId);
      assertEquals(knocked.created, true);
      assert(sentKnock);
      const [accepted] = await invitesOf(userId, deps);
      pdu = JSON.parse(accepted.eventJson) as Pdu;
      assertEquals(pdu.content, sentKnock.content);
      assertEquals(
        remote.requests.filter((request) =>
          request.path.includes('/send_knock/')
        ).length,
        1,
      );
    }
    const records = await new MembershipOperations(home, ht, hp).bootstrap(
      'alice',
      bundle.id,
    );
    assertEquals(records.length, kind === 'invite' ? 1 : 2);
    const record = records.at(-1)!;
    const directory = await exportDirectoryReplica(
      home,
      ht,
      node.node,
      bundle.id,
      2,
    );
    assert(directory);
    await journal.receive('home', [directory]);
    await new DirectoryReplicas(await edge.server(), fp, 'logical.test').apply(
      journal,
      directory,
    );
    await et.tx((tx) => tx.devices.upsert('EDGE', 'alice', null));
    await edge.close();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      federation: { enabled: false },
      facade: {
        phase: 'f2',
        nodeid: 'edge_a',
        url,
        pairfile: '',
        linkcert: tls.dir + '/facade.crt',
        linkkey: tls.dir + '/facade.key',
        linkcacerts: [tls.dir + '/ca.crt'],
      },
    });
    let completed = Promise.withResolvers<boolean>();
    let target = record;
    runtime = await openFacadeRuntime(settings('edge'), (_journal, stream) => {
      if (stream.stream === target.stream) completed.resolve(false);
      return Promise.resolve(false);
    });
    await assertRejects(
      () => runtime!.requireScope('rooms'),
      MatrixError,
      'unavailable',
    );
    const complete = runtime.journal.complete.bind(runtime.journal);
    runtime.journal.complete = async (...args) => {
      try {
        const result = await complete(...args);
        if (
          args[1].stream === target.stream &&
          args[2].sequence === target.sequence
        ) completed.resolve(true);
        return result;
      } catch (error) {
        if (args[1].stream === target.stream) completed.reject(error);
        throw error;
      }
    };
    const deliver = async (pending: LinkRecord[]) => {
      assert(pending.length);
      target = pending.at(-1)!;
      completed = Promise.withResolvers<boolean>();
      await runtime!.journal.receive('home', pending);
      await runtime!.changed();
      assertEquals(await completed.promise, true);
    };
    await deliver(records);
    const displayed = await invitesOf(userId, { server: runtime.server });
    assertEquals(displayed.map((invite) => invite.eventId), [pdu.event_id]);
    assertEquals(
      (await runtime.journal.heads('home', 'in', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(await runtime.server.query('SELECT * FROM prejoin_jobs'), []);
    assertEquals(await runtime.store.rooms(), []);
    await runtime.requireScope('rooms');
    const granted = await runtime.grantedTenant();
    assert(granted);
    await openReplicaApp(runtime.store, granted, {
      ...runtime,
      signer: await runtime.requestSigner(),
      keys: await runtime.verificationKeys(),
    });
    appBound = true;
    const ordinary = await syncFor({
      userId,
      deviceId: 'EDGE',
      since: null,
      timeoutMs: 0,
      filter: DEFAULT_ROOM_FILTER,
      fullState: false,
    });
    const ordinaryRooms = ordinary.rooms as Record<
      string,
      Record<string, unknown>
    >;
    assert(Object.hasOwn(ordinaryRooms[kind], roomId));
    const ordinaryInvite = ordinaryRooms[kind][roomId] as Record<
      string,
      unknown
    >;
    const ordinaryState =
      (ordinaryInvite[kind + '_state'] as Record<string, unknown>)
        .events as Record<string, unknown>[];
    const ordinaryMember = ordinaryState.find((event) =>
      event.type === 'm.room.member' && event.state_key === userId
    );
    assert(ordinaryMember);
    assertEquals(ordinaryMember.content, pdu.content);
    const sliding = await slidingSync({
      userId,
      deviceId: 'EDGE',
      request: slidingSyncRequest(
        {
          conn_id: 'membership-' + kind,
          lists: {
            main: {
              ranges: [[0, 19]],
              required_state: [],
              timeline_limit: 0,
            },
          },
        },
        new URLSearchParams(),
        0,
      ),
    });
    const slidingRooms = sliding.rooms as Record<
      string,
      Record<string, unknown>
    >;
    assert(Array.isArray(slidingRooms[roomId].invite_state));
    const membership =
      (slidingRooms[roomId].invite_state as Record<string, unknown>[])
        .find((event) =>
          event.type === 'm.room.member' && event.state_key === userId
        );
    assert(membership);
    assertEquals(membership.content, pdu.content);
    // The source lifecycle owner, not a fabricated imported status, prepares a
    // real signed local departure and its independent remote delivery job.
    await rejectInviteRemote(roomId, userId, deps, 'runtime departure');
    const [sourceLeave] = await invitesOf(userId, deps);
    assert(sourceLeave.localLeaveJson);
    const leave = JSON.parse(sourceLeave.localLeaveJson) as Pdu;
    assertEquals(leave.content, {
      membership: 'leave',
      reason: 'runtime departure',
    });
    const successors = await new MembershipOperations(home, ht, hp).export(
      'alice',
      bundle.id,
    );
    await deliver(successors);
    const incremental = await syncFor({
      userId,
      deviceId: 'EDGE',
      since: parseStreamToken(String(ordinary.next_batch)),
      timeoutMs: 0,
      filter: DEFAULT_ROOM_FILTER,
      fullState: false,
    });
    const ordinaryLeave = (incremental.rooms as Record<
      string,
      Record<string, Record<string, unknown>>
    >).leave[roomId];
    assert(ordinaryLeave);
    assertEquals(
      (ordinaryLeave.state as { events: Record<string, unknown>[] }).events
        .find((event) =>
          event.type === 'm.room.member' && event.state_key === userId
        ),
      {
        event_id: leave.event_id,
        type: leave.type,
        sender: leave.sender,
        state_key: userId,
        content: leave.content,
        origin_server_ts: leave.origin_server_ts,
      },
    );
    const slidingLeave = await slidingSync({
      userId,
      deviceId: 'EDGE',
      request: slidingSyncRequest(
        {
          conn_id: 'membership-' + kind,
          room_subscriptions: {
            [roomId]: {
              required_state: [['m.room.member', userId]],
              timeline_limit: 1,
            },
          },
        },
        new URLSearchParams({ pos: String(sliding.pos) }),
        0,
      ),
    });
    const departure = (slidingLeave.rooms as Record<string, {
      timeline?: Record<string, unknown>[];
      required_state?: Record<string, unknown>[];
    }>)[roomId];
    assert(departure);
    for (const events of [departure.timeline, departure.required_state]) {
      assert(events);
      assertEquals(
        events.find((event) => event.event_id === leave.event_id)?.content,
        leave.content,
      );
    }
    assertEquals(await runtime.server.query('SELECT * FROM prejoin_jobs'), []);
    assertEquals(await runtime.store.rooms(), []);
    const counters = await runtime.server.query(
      'SELECT * FROM counters ORDER BY name',
    );
    // A cold receiver resumes the applied exact identity without creating work,
    // signing a replacement leave, or assigning another live publication.
    await runtime.close();
    await closeApp();
    appBound = false;
    runtime = await openFacadeRuntime(settings('edge'));
    const [cold] = await invitesOf(userId, { server: runtime.server });
    assert(cold.localLeaveJson);
    assertEquals(
      JSON.parse(cold.localLeaveJson),
      JSON.parse(sourceLeave.localLeaveJson),
    );
    assertEquals(
      await runtime.server.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(await runtime.server.query('SELECT * FROM prejoin_jobs'), []);
    assertEquals(await runtime.store.rooms(), []);
    if (kind === 'invite') {
      const localRoom = '!local-cold-leave:remote.test';
      const sent = Promise.withResolvers<
        { path: string; pdu: Record<string, unknown> }
      >();
      localRemote = await startFakeServer({
        ourKeyDoc: () =>
          Promise.resolve({
            server_name: 'logical.test',
            verify_keys: { [node.keyId]: { key: node.publicKey } },
          }),
        handlers: (request) => {
          if (request.url.pathname.includes('/make_leave/')) {
            assert(request.verified);
            return Response.json({
              room_version: '11',
              event: {
                type: 'm.room.member',
                room_id: localRoom,
                sender: userId,
                state_key: userId,
                content: { membership: 'leave' },
                prev_events: [],
                auth_events: [],
                depth: 2,
              },
            });
          }
          if (request.url.pathname.includes('/send_leave/')) {
            return (async () => {
              assert(request.verified);
              sent.resolve({
                path: request.url.pathname,
                pdu: request.json() as Record<string, unknown>,
              });
              await releaseLocalLeave.promise;
              return Response.json({});
            })();
          }
          return null;
        },
      });
      await seedServer(runtime.server, localRemote);
      const localInvite = await remoteEvent(localRoom, localRemote, '11', {
        type: 'm.room.member',
        sender: '@inviter:' + localRemote.name,
        state_key: userId,
        content: { membership: 'invite' },
        prev_events: [],
      });
      const localDeps = {
        store: runtime.store,
        server: runtime.server,
        self: 'logical.test',
        signer: await runtime.requestSigner(),
        keys: fakeKeyResolver(localRemote),
        wake() {},
      };
      await receiveInvite(
        localRoom,
        String(localInvite.event_id),
        {
          room_version: '11',
          event: localInvite,
          invite_room_state: [],
        },
        localRemote.name,
        localDeps,
      );
      await rejectInviteRemote(localRoom, userId, localDeps, 'owned cold job');
      const [owned] = await runtime.server.query('SELECT * FROM prejoin_jobs');
      assert(owned);
      assertEquals(owned.room_id, localRoom);
      assertEquals(owned.status, 'rejecting');
      assertEquals(
        localRemote.requests.filter((request) =>
          request.path.includes('/send_leave/')
        ).length,
        0,
      );
      await runtime.close();
      setConfigForTests({
        server: { name: 'logical.test', role: 'facade' },
        federation: { enabled: true, cacerts: ['tests/fixtures/tls/ca.crt'] },
        facade: {
          phase: 'f2',
          nodeid: 'edge_a',
          url,
          pairfile: '',
          linkcert: tls.dir + '/facade.crt',
          linkkey: tls.dir + '/facade.key',
          linkcacerts: [tls.dir + '/ca.crt'],
        },
      });
      resetCaCertsForTests();
      runtime = await openFacadeRuntime(settings('edge'));
      const sender = await runtime.sender();
      assert(sender);
      try {
        // A missing production provider fails here without a timer or a test
        // calling the membership performer on behalf of the runtime.
        assert(
          (await sender.reviewIntents())?.some((job) =>
            job.destination === localRemote!.name
          ),
        );
        await sent.promise;
      } finally {
        releaseLocalLeave.resolve();
      }
      // Stop joins the actual in-flight delivery, including its owner commit.
      // A remote request alone is not proof that local work completed.
      await runtime.releaseServices();
      const [finished] = await runtime.server.query(
        'SELECT * FROM prejoin_jobs WHERE job_id=?',
        [owned.job_id],
      );
      assertEquals(finished.status, 'rejected');
      const work = JSON.parse(String(finished.work_json));
      const delivered = await sent.promise;
      assertEquals(delivered.pdu, toWire(JSON.parse(work.eventJson), '11'));
      assertEquals(
        decodeURIComponent(delivered.path.split('/').at(-1)!),
        JSON.parse(work.eventJson).event_id,
      );
      assertEquals(
        localRemote.requests.filter((request) =>
          request.path.includes('/send_leave/')
        ).length,
        1,
      );
      assertEquals(
        (await runtime.server.query('SELECT * FROM prejoin_jobs')).length,
        1,
      );
      await runtime.close();
      runtime = await openFacadeRuntime(settings('edge'));
      const restarted = await runtime.sender();
      assert(restarted);
      assertEquals(await restarted.reviewIntents(), []);
      await runtime.releaseServices();
      assertEquals(
        localRemote.requests.filter((request) =>
          request.path.includes('/send_leave/')
        ).length,
        1,
      );
    }
  } finally {
    releaseLocalLeave.resolve();
    await runtime?.close();
    if (appBound) await closeApp();
    await edge.close();
    await home.close();
    await remote?.close();
    await localRemote?.close();
    setConfigForTests({});
    resetCaCertsForTests();
    await tls.close();
  }
}

for (const kind of ['invite', 'knock'] as const) {
  Deno.test(
    'membership runtime: typed ' + kind +
      ' and departure reach both sync consumers without foreign jobs',
    () => membershipRuntime(kind),
  );
}
