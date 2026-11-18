import { assert, assertEquals, assertRejects } from '@std/assert';
import { closeApp, openReplicaApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { syncFor } from '#engine/syncfeed.ts';
import { slidingSync } from '#engine/sliding-sync/index.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { DEFAULT_ROOM_FILTER } from '#engine/tenant/filters.ts';
import { setConfigForTests } from '#engine/config.ts';
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
import { LINK_CAPABILITIES, LINK_SUPPORTED } from '#engine/facade/protocol.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import { invitesOf, receiveInvite } from '#engine/federation/invites.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { fakeKeyResolver, remoteEvent } from './fixtures/remote.ts';
import { testRemoteServer } from './fixtures/signer.ts';
import { seedServer } from './federation/doc-helper.ts';
import { facadeTls } from './support/facade-tls.ts';

// The production inbox, not a directly called membership adapter, owns apply.
// Retain its exact completion without a wall-clock readiness assertion.
Deno.test('membership runtime: typed inbox applies authentic home display without creating a foreign job', async () => {
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
    const remote = await testRemoteServer('remote.test');
    await seedServer(await edge.server(), remote);
    const roomId = '!runtime-invite:remote.test',
      userId = '@alice:logical.test';
    const pdu = await remoteEvent(roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@inviter:remote.test',
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
      'remote.test',
      {
        store: home,
        server: await home.server(),
        self: 'logical.test',
        signer: ht.signer(),
        keys: fakeKeyResolver(remote),
        wake() {},
      },
    );
    const records = await new MembershipOperations(home, ht, hp).bootstrap(
      'alice',
      bundle.id,
    );
    assertEquals(records.length, 1);
    const record = records[0];
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
    const completed = Promise.withResolvers<boolean>();
    runtime = await openFacadeRuntime(settings('edge'), (_journal, stream) => {
      if (stream.stream === record.stream) completed.resolve(false);
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
        if (args[1].stream === record.stream) completed.resolve(true);
        return result;
      } catch (error) {
        if (args[1].stream === record.stream) completed.reject(error);
        throw error;
      }
    };
    await runtime.journal.receive('home', [record]);
    await runtime.changed();
    assertEquals(await completed.promise, true);
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
    assert(Object.hasOwn(ordinaryRooms.invite, roomId));
    const ordinaryInvite = ordinaryRooms.invite[roomId] as Record<
      string,
      unknown
    >;
    const ordinaryState =
      (ordinaryInvite.invite_state as Record<string, unknown>)
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
  } finally {
    await runtime?.close();
    if (appBound) await closeApp();
    await edge.close();
    await home.close();
    setConfigForTests({});
    await tls.close();
  }
});
