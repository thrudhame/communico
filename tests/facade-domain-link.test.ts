import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { setConfigForTests } from '#engine/config.ts';
import {
  importReportOperation,
  listReports,
  reportOperations,
  resolveReport,
  storeReport,
} from '#engine/server/reports.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import {
  type DomainBootstrap,
  type DomainOperation,
  DomainOperations,
} from '#engine/facade/domain.ts';
import {
  enrolledTenant,
  initializeNode,
  loadNode,
} from '#engine/facade/identity.ts';
import { AuthLinkHealth, FacadeAuth } from '#engine/facade/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  clearPurgeable,
  forget,
  forgetOperations,
  importForgetOperation,
  prepareRejoin,
  projectRejoin,
  type RejoinObservation,
} from '#engine/server/membership.ts';
import {
  membershipOf,
  roomsFor,
  slidingListSnapshot,
} from '#engine/server/read.ts';
import { installDirectoryFacts } from '#engine/server/public-replica.ts';
import { installJoinAdmission } from '#engine/server/join-attempts.ts';
import { setJoinObservation } from '#engine/room/hooks.ts';
import {
  join as joinLocal,
  leave as leaveLocal,
} from '#engine/room/membership.ts';
import { project } from '#engine/server/project.ts';
import {
  ingestLocal,
  type PreparedSubmission,
  sendLocal,
} from '#engine/room/ingest.ts';
import { buildInTx } from '#engine/room/build.ts';
import { loadFilter, storeFilter } from '#engine/tenant/filters.ts';
import { issueOpenIdToken, openIdUserInfo } from '#engine/tenant/openid.ts';
import { hashToken, issueToken, lookupToken } from '#engine/tenant/auth.ts';
import {
  recordPusherChange,
  setPusher,
  upsertPusherRow,
} from '#engine/tenant/pushers.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { queueBadge } from '#engine/server/push-queue.ts';
import { startPushSender } from '#engine/push/sender.ts';
import { setAvatarUrl, setDisplayName } from '#engine/tenant/users.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { MembershipOperations } from '#engine/facade/membership.ts';
import { bindRole } from '#engine/facade/role.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
  type LinkRecord,
  recordHash,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { createRoom } from '#engine/room/create.ts';
import { joinRemote } from '#engine/room/join.ts';
import { importReplicaGenesis } from '#engine/room/replica.ts';
import { recoverServer } from '#engine/server/startup.ts';
import {
  DirectoryReplicas,
  exportDirectoryReplica,
} from '#engine/facade/directory.ts';
import { appendRecord } from '#engine/facade/journal.ts';
import { exportRoomReplica } from '#engine/facade/replication.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  captureAccountDataOperations,
  getAccountData,
  putAccountData,
  updateRoomTag,
} from '#engine/tenant/accountdata.ts';
import {
  captureProfileOperations,
  getPublicProfile,
  setProfileField,
} from '#engine/tenant/profiles.ts';
import {
  capturePushRuleOperations,
  putRule,
  rulesetFor,
  setRuleEnabled,
} from '#engine/tenant/pushrules.ts';
import {
  importRegisterOperation,
  writeRegister,
} from '#engine/facade/registers.ts';
import {
  receiptOperations,
  recordReceiptOperation,
} from '#engine/server/receipt-operations.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-domain-link-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    });
  const home = await open('home'), edge = await open('edge');
  await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
  await bindRole(edge, {
    role: 'facade',
    server: 'logical.test',
    node: 'edge_a',
  });
  const ht = await openTenant(home, 'logical.test', { create: true });
  await ht.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    ht.signer(),
    ht.publicB64,
    'a'.repeat(64),
  );
  const fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
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
        await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
      ),
      'a'.repeat(64),
    ),
  );
  const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const hj = new Journal(await home.server(), LINK_SUPPORTED),
    ej = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const control = await exportOwnerControl(home, ht, hp, bundle.id);
  await ej.receive('home', [control]);
  await owners.apply(ej, control);
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await ej.receive('home', [auth]);
  await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  const hs = new DomainOperations(home, ht, hp),
    es = new DomainOperations(edge, et, fp, node);
  return {
    dir,
    open,
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    hj,
    ej,
    owners,
    node,
    bundle,
    hs,
    es,
    capture: () =>
      (home.tenant('logical.test')).then((db) =>
        db.tx(async (conn) => {
          await captureAccountDataOperations(conn, 'alice');
          await captureProfileOperations(conn, 'alice');
          await capturePushRuleOperations(conn, 'alice', 'logical.test');
        })
      ),
    async toEdge(records: LinkRecord[]) {
      for (const record of records) {
        await ej.receive('home', [record]);
        await es.apply(ej, record);
      }
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade pusher authority: registration and background delivery stay at the session issuer', async (t) => {
  for (
    const mode of [
      'native registration',
      'native row upsert',
      'background sender',
    ]
  ) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        const token = await issueToken(f.ht, 'alice', 'HOME_PUSH');
        const pusher = {
          app_id: 'app',
          pushkey: 'key',
          kind: 'http',
          app_display_name: 'App',
          device_display_name: 'Home',
          lang: 'en',
          data: { url: 'https://push.test/_matrix/push/v1/notify' },
        };
        await setPusher(f.ht, 'alice', token, pusher);
        const auth = await exportAccountAuth(
          f.home,
          f.ht,
          f.hp,
          f.bundle.id,
          'alice',
          false,
        );
        await f.ej.receive('home', [auth]);
        await new AccountSnapshots(f.edge, f.et, f.fp, f.owners).apply(
          f.ej,
          auth,
        );
        const ed = await f.edge.tenant('logical.test'),
          hd = await f.home.tenant('logical.test');
        if (mode === 'native registration') {
          await assertRejects(
            () => setPusher(f.et, 'alice', token, pusher),
            MatrixError,
            'operation owner unavailable',
          );
          assertEquals(await ed.query('SELECT * FROM pushers'), []);
          assertEquals(await ed.query('SELECT * FROM pusher_changes'), []);
        } else if (mode === 'native row upsert') {
          const hash = await hashToken(token);
          await assertRejects(
            () => ed.tx((tx) => upsertPusherRow(tx, 'alice', pusher, hash)),
            MatrixError,
            'operation owner unavailable',
          );
          assertEquals(await ed.query('SELECT * FROM pushers'), []);
        } else {
          // Pre-existing protected replica state must never become sender authority.
          const [row] = await hd.query('SELECT * FROM pushers');
          const columns = Object.keys(row);
          await ed.tx(async (tx) => {
            await tx.execute(
              'INSERT INTO pushers(' + columns.join(',') + ') VALUES(' +
                columns.map(() => '?').join(',') + ')',
              columns.map((key) => row[key]),
            );
            await recordPusherChange(tx, row, false);
          });
          const sent = { home: 0, edge: 0 };
          for (const side of ['home', 'edge'] as const) {
            const store = f[side], tenant = side === 'home' ? f.ht : f.et;
            await projectTenant(store, 'logical.test');
            await (await store.server()).tx((tx) =>
              queueBadge(tx, '@alice:logical.test')
            );
            const sender = await startPushSender({
              store,
              tenant,
              automatic: false,
              send: () => {
                sent[side]++;
                return Promise.resolve([]);
              },
            });
            try {
              await sender.tick();
            } finally {
              await sender.stop();
            }
          }
          assertEquals(
            sent.home,
            1,
            'issuer did not send its own registration',
          );
          assertEquals(
            sent.edge,
            0,
            'replica independently sent the same registration',
          );
        }
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('facade forget: F2 directory import preserves receiver purgeability and local-only rooms', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.server();
    await db.execute(
      'INSERT INTO directory(room_id,purgeable_ms) VALUES(?,NULL),(?,NULL)',
      ['!active:logical.test', '!local:logical.test'],
    );
    await db.tx((tx) =>
      installDirectoryFacts(tx, {
        aliases: [],
        publication: [{
          roomId: '!active:logical.test',
          visibility: 'public',
          purgeable: 123,
        }],
        forgotten: [],
      }, 'logical.test')
    );
    assertEquals(
      await db.query(
        'SELECT room_id,purgeable_ms FROM directory ORDER BY room_id',
      ),
      [
        { room_id: '!active:logical.test', purgeable_ms: null },
        { room_id: '!local:logical.test', purgeable_ms: null },
      ],
    );
    assertEquals(
      (await db.query('SELECT visibility FROM visibility WHERE room_id=?', [
        '!active:logical.test',
      ]))[0].visibility,
      'public',
    );
    // The pre-F2 snapshot contract is unchanged.
    await db.execute('DELETE FROM facade_owner_activation');
    await db.tx((tx) =>
      installDirectoryFacts(tx, {
        aliases: [],
        publication: [{
          roomId: '!active:logical.test',
          visibility: 'private',
          purgeable: 456,
        }],
        forgotten: [],
      }, 'logical.test')
    );
    assertEquals(await db.query('SELECT room_id,purgeable_ms FROM directory'), [
      { room_id: '!active:logical.test', purgeable_ms: 456 },
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: imported join projection clears purgeability without clearing concurrent intent', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.server();
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    const received = await makeFakeRoom({
      roomId: '!imported-forget:logical.test',
      creator: '@alice:logical.test',
      server: await makeRemoteServer('logical.test'),
    });
    const events = [...received.events.values()];
    await db.execute(
      "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
      ['@alice:logical.test', received.roomId, '$prior-leave'],
    );
    await forget(db, received.roomId, '@alice:logical.test', 'logical.test');
    assertEquals(
      typeof (await db.query(
        'SELECT purgeable_ms FROM directory WHERE room_id=?',
        [received.roomId],
      ))[0].purgeable_ms,
      'number',
    );
    await importReplicaGenesis(f.edge, {
      roomId: received.roomId,
      roomVersion: received.version,
      self: 'logical.test',
      keys: fakeKeyResolver(received.server),
      create: events[0],
      join: events[1],
    });
    await project(f.edge, received.roomId);
    assertEquals(
      (await membershipOf(db, received.roomId, '@alice:logical.test'))!
        .membership,
      'join',
    );
    assertEquals(
      (await membershipOf(db, received.roomId, '@alice:logical.test'))!
        .forgotten,
      true,
    );
    assertEquals(
      (await db.query('SELECT purgeable_ms FROM directory WHERE room_id=?', [
        received.roomId,
      ]))[0].purgeable_ms,
      null,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: profile-style self joins do not observe a rejoin', async (t) => {
  for (const mode of ['direct local', 'prepared client', 'raw local']) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        installJoinAdmission(f.home);
        const user = '@alice:logical.test';
        const created = await createRoom(f.home, {
          creator: '@bob:logical.test',
          preset: 'public_chat',
        }, f.ht.signer());
        const room = await openRoom(f.home, created.roomId),
          hd = await f.home.server(),
          ed = await f.edge.server();
        await joinLocal(room, user, f.ht.signer());
        await project(f.home, room.id);
        await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
        await ed.execute(
          "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
          [user, room.id, '$other-branch-leave'],
        );
        await forget(ed, room.id, user, 'logical.test');
        for (const op of await ed.tx((tx) => forgetOperations(tx, user))) {
          await importForgetOperation(hd, op, async () => {});
        }
        assertEquals((await membershipOf(hd, room.id, user))!.forgotten, true);
        let retained: PreparedSubmission | null = null;
        const event = {
          type: 'm.room.member',
          sender: user,
          state_key: user,
          content: { membership: 'join', displayname: 'Updated profile' },
        };
        if (mode === 'raw local') {
          const pdu = await room.tx((tx) =>
            buildInTx(tx, room.id, event, f.ht.signer())
          );
          await ingestLocal(room, pdu, 'logical.test');
        } else {await sendLocal(
            room,
            event,
            f.ht.signer(),
            mode === 'prepared client'
              ? {
                lookup: () => Promise.resolve(retained),
                prepare: (pdu) =>
                  Promise.resolve(
                    retained = { eventId: String(pdu.event_id), pdu },
                  ),
                finish: async () => {},
              }
              : undefined,
          );}
        await project(f.home, room.id);
        assertEquals(
          (await membershipOf(hd, room.id, user))!.forgotten,
          true,
          'profile update cleared concurrent forget',
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('facade forget: acceptance retains a same-transaction export fact', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.server();
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await db.execute(
      "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
      ['@alice:logical.test', '!forgot:logical.test', '$leave'],
    );
    await forget(
      db,
      '!forgot:logical.test',
      '@alice:logical.test',
      'logical.test',
    );
    assertEquals(
      (await db.query("SELECT * FROM domain_operations WHERE kind='forget'"))
        .length,
      1,
      'accepted forget has no durable export fact',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: invite and knock housekeeping cannot erase user intent', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.server();
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await db.execute(
      "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
      ['@alice:logical.test', '!forgot:logical.test', '$leave'],
    );
    await forget(
      db,
      '!forgot:logical.test',
      '@alice:logical.test',
      'logical.test',
    );
    await clearPurgeable(db, '!forgot:logical.test', '@alice:logical.test');
    assertEquals(
      (await db.query('SELECT * FROM forgotten')).length,
      1,
      'housekeeping erased forget without observed rejoin',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: delayed rejoin clears only admission-observed facts and converges out of order', async () => {
  const f = await fixture();
  const room = '!forgot:logical.test', user = '@alice:logical.test';
  try {
    const hd = await f.home.server(), ed = await f.edge.server();
    for (const db of [hd, ed]) {
      await db.execute(
        "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
        [user, room, '$leave'],
      );
    }
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await forget(ed, room, user, 'logical.test');
    const before = await prepareRejoin(ed, room, user) as RejoinObservation;
    await forget(hd, room, user, 'logical.test');
    await f.toEdge(await f.hs.export('alice', f.bundle.id));
    // Its late projection observes a newer fact, but the join itself did not.
    await ed.tx((tx) =>
      projectRejoin(tx, room, '$rejoin-before', before, 'logical.test')
    );
    assertEquals((await membershipOf(ed, room, user))!.forgotten, true);
    const unresolved = await ed.tx((tx) => forgetOperations(tx, user));
    for (const op of unresolved.toReversed()) {
      await importForgetOperation(hd, op, async () => {});
    }
    assertEquals((await membershipOf(hd, room, user))!.forgotten, true);
    const after = await prepareRejoin(ed, room, user) as RejoinObservation;
    await ed.tx((tx) =>
      projectRejoin(tx, room, '$rejoin-after', after, 'logical.test')
    );
    const facts = await ed.tx((tx) => forgetOperations(tx, user));
    for (const op of facts.toReversed()) {
      await importForgetOperation(hd, op, async () => {});
    }
    assertEquals((await membershipOf(hd, room, user))!.forgotten, false);
    assertEquals((await membershipOf(ed, room, user))!.forgotten, false);
    await ed.tx((tx) =>
      projectRejoin(tx, room, '$rejoin-before', before, 'logical.test')
    );
    assertEquals(
      (await ed.tx((tx) => forgetOperations(tx, user))).length,
      facts.length,
      'replay invented a new observation',
    );
    await forget(ed, room, user, 'logical.test');
    await ed.tx((tx) =>
      installDirectoryFacts(
        tx,
        { aliases: [], publication: [], forgotten: [] },
        'logical.test',
      )
    );
    assertEquals(
      (await membershipOf(ed, room, user))!.forgotten,
      true,
      'F1 snapshot removed F2 intent',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: explicit legacy inventory repairs F1 rows and guards every membership consumer', async () => {
  const f = await fixture();
  const room = '!forgot:logical.test', user = '@alice:logical.test';
  try {
    const hd = await f.home.server(), ed = await f.edge.server();
    await hd.execute('INSERT INTO forgotten(user,room) VALUES(?,?)', [
      user,
      room,
    ]);
    await ed.execute('INSERT INTO forgotten(user,room) VALUES(?,?)', [
      user,
      '!stale:logical.test',
    ]);
    await ed.execute(
      "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
      [user, room, '$leave'],
    );
    for (
      const read of [
        () => membershipOf(ed, room, user),
        () => roomsFor(ed, user),
        () => slidingListSnapshot(ed, user),
      ]
    ) await assertRejects(read, MatrixError, 'forget snapshot unavailable');
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    assertEquals((await membershipOf(ed, room, user))!.forgotten, true);
    assertEquals(
      (await ed.query('SELECT room FROM forgotten WHERE user=?', [user])).map((
        row,
      ) => row.room),
      [room],
    );
    const source = await hd.tx((tx) => forgetOperations(tx, user));
    assertEquals(source.length, 1);
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    assertEquals(
      (await hd.tx((tx) => forgetOperations(tx, user))).length,
      1,
      'bootstrap reauthored a legacy fact',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: visibility failure rolls back the source fact and imported intent', async () => {
  const f = await fixture();
  const room = '!forgot:logical.test', user = '@alice:logical.test';
  try {
    const hd = await f.home.server(), ed = await f.edge.server();
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    for (const db of [hd, ed]) {
      await db.execute(
        "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'leave',?,1)",
        [user, room, '$leave'],
      );
    }
    await ed.exec(
      "CREATE TRIGGER forget_fail BEFORE INSERT ON forgotten BEGIN SELECT RAISE(ABORT,'forget rollback'); END",
    );
    await assertRejects(
      () => forget(ed, room, user, 'logical.test'),
      Error,
      'forget rollback',
    );
    assertEquals(await ed.tx((tx) => forgetOperations(tx, user)), []);
    await forget(hd, room, user, 'logical.test');
    const [op] = await hd.tx((tx) => forgetOperations(tx, user));
    await assertRejects(
      () => importForgetOperation(ed, op, async () => {}),
      Error,
      'forget rollback',
    );
    assertEquals(await ed.tx((tx) => forgetOperations(tx, user)), []);
    await ed.exec('DROP TRIGGER forget_fail');
    await importForgetOperation(ed, op, async () => {});
    assertEquals((await ed.query('SELECT room FROM forgotten')).length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: actual local join retains admission context across cold projection and idempotent retry', async () => {
  const f = await fixture();
  const user = '@alice:logical.test';
  try {
    installJoinAdmission(f.home);
    const created = await createRoom(f.home, {
      creator: '@bob:logical.test',
      preset: 'public_chat',
    }, f.ht.signer());
    const room = await openRoom(f.home, created.roomId),
      db = await f.home.server();
    await joinLocal(room, user, f.ht.signer());
    await project(f.home, room.id);
    await leaveLocal(room, user, f.ht.signer());
    await project(f.home, room.id);
    await forget(db, room.id, user, 'logical.test');
    setJoinObservation(f.home, async (roomId, userId) => {
      const captured = await prepareRejoin(db, roomId, userId);
      await forget(db, roomId, userId, 'logical.test');
      return captured;
    });
    const joined = await joinLocal(room, user, f.ht.signer());
    assertEquals(joined.created, true);
    // Explicit cold roll-forward uses room-retained context, not a fresh read.
    await f.home.close();
    const reopened = await f.open('home');
    try {
      await recoverServer(reopened);
      const server = await reopened.server(),
        retainedRoom = await openRoom(reopened, room.id);
      assertEquals(
        (await membershipOf(server, room.id, user))!.forgotten,
        true,
      );
      const count = (await server.tx((tx) =>
        forgetOperations(tx, user)
      )).length;
      assertEquals(
        (await joinLocal(retainedRoom, user, f.ht.signer())).created,
        false,
      );
      await project(reopened, room.id);
      assertEquals(
        (await server.tx((tx) => forgetOperations(tx, user))).length,
        count,
      );
      assertEquals(
        (await membershipOf(server, room.id, user))!.forgotten,
        true,
      );
      await leaveLocal(retainedRoom, user, f.ht.signer());
      await project(reopened, room.id);
      await joinLocal(retainedRoom, user, f.ht.signer());
      await project(reopened, room.id);
      assertEquals(
        (await membershipOf(server, room.id, user))!.forgotten,
        false,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade forget: prepared client membership retry retains its original observation before room commit', async () => {
  const f = await fixture();
  const user = '@alice:logical.test';
  try {
    installJoinAdmission(f.home);
    const created = await createRoom(f.home, {
      creator: '@bob:logical.test',
      preset: 'public_chat',
    }, f.ht.signer());
    const room = await openRoom(f.home, created.roomId),
      db = await f.home.server();
    await joinLocal(room, user, f.ht.signer());
    await leaveLocal(room, user, f.ht.signer());
    await project(f.home, room.id);
    await forget(db, room.id, user, 'logical.test');
    let retained: PreparedSubmission | null = null;
    const event = {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join' },
    };
    const submission = {
      lookup: () => Promise.resolve(retained),
      prepare: (
        pdu: import('#engine/pdu.ts').Pdu,
      ): Promise<PreparedSubmission> => {
        retained = { eventId: String(pdu.event_id), pdu };
        return Promise.reject(new Error('prepared interruption'));
      },
      finish: async () => {},
    };
    await assertRejects(
      () => sendLocal(room, event, f.ht.signer(), submission),
      Error,
      'prepared interruption',
    );
    await forget(db, room.id, user, 'logical.test');
    await f.home.close();
    const reopened = await f.open('home');
    try {
      installJoinAdmission(reopened);
      const replayRoom = await openRoom(reopened, room.id);
      const result = await sendLocal(
        replayRoom,
        event,
        f.ht.signer(),
        submission,
      );
      assertEquals(result.eventId, retained!.eventId);
      await project(reopened, room.id);
      assertEquals(
        (await membershipOf(await reopened.server(), room.id, user))!.forgotten,
        true,
        'retry replaced original context with a new observation',
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: accepted submission retains an atomic immutable export fact', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.server();
    await storeReport(db, {
      kind: 'user',
      reporter: '@alice:logical.test',
      userId: '@bob:logical.test',
      reason: 'private report',
    });
    const facts = await db.query(
      "SELECT * FROM domain_operations WHERE kind='report'",
    );
    assertEquals(facts.length, 1, 'accepted report has no durable export fact');
    const [row] = (await listReports(db)).reports;
    assertEquals(
      JSON.parse(String(facts[0].payload_json)).receivedMs,
      row.receivedMs,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: resolution is refused by the server owner at facade ingress', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.server();
    await storeReport(db, {
      kind: 'user',
      reporter: '@alice:logical.test',
      userId: '@bob:logical.test',
      reason: '',
    });
    const error = await assertRejects(
      () => resolveReport(db, 1, 'illicit edge resolution'),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assertEquals((await listReports(db)).reports[0].resolvedMs, null);
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: signed append union preserves both integer-ID collisions and home resolution', async () => {
  const f = await fixture();
  try {
    const hd = await f.home.server(), ed = await f.edge.server();
    for (
      const [db, reason] of [[hd, 'home-private'], [
        ed,
        'edge-private',
      ]] as const
    ) {
      await storeReport(db, {
        kind: 'user',
        reporter: '@alice:logical.test',
        userId: '@bob:logical.test',
        reason,
      });
    }
    const home = (await listReports(hd)).reports[0],
      edge = (await listReports(ed)).reports[0];
    assertEquals(home.id, edge.id);
    assertEquals(home.reportId === edge.reportId, false);
    for (const record of await f.es.export('alice')) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const imported = (await listReports(hd)).reports.find((r) =>
      r.reportId === edge.reportId
    )!;
    assertEquals(imported.reason, 'edge-private');
    assertEquals(imported.receivedMs, edge.receivedMs);
    const resolution = await resolveReport(hd, imported.id, 'home-reviewed');
    assertEquals(
      await resolveReport(hd, imported.id, 'ignored second resolution'),
      resolution,
    );
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(records);
    await f.toEdge(records);
    const rows = (await listReports(ed)).reports;
    assertEquals(rows.length, 2);
    const observed = rows.find((r) => r.reportId === edge.reportId)!;
    assertEquals(observed.resolvedMs, resolution.resolvedMs);
    assertEquals(observed.resolution, 'home-reviewed');
    assertEquals(
      (await ed.query(
        "SELECT * FROM domain_operations WHERE kind='report-resolution'",
      )).length,
      1,
    );
    assertEquals(await ed.query('SELECT * FROM feed'), []);
    assertEquals(await ed.query('SELECT * FROM outbox'), []);
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: resolution before submission, replay and protected diagnostics', async () => {
  const f = await fixture();
  try {
    const hd = await f.home.server(), ed = await f.edge.server();
    await storeReport(hd, {
      kind: 'room',
      reporter: '@alice:logical.test',
      roomId: '!held:logical.test',
      reason: 'protected',
    });
    await resolveReport(hd, 1, 'resolved before transmission');
    const facts = await hd.tx((conn) =>
      reportOperations(conn, '@alice:logical.test')
    );
    const submission = facts.find((o) => o.kind === 'report')!,
      resolution = facts.find((o) => o.kind === 'report-resolution')!;
    const check = async () => {};
    await importReportOperation(ed, resolution, check);
    assertEquals((await listReports(ed)).reports, []);
    await importReportOperation(ed, submission, check);
    await importReportOperation(ed, resolution, check);
    assertEquals(
      (await listReports(ed)).reports[0].resolution,
      'resolved before transmission',
    );
    for (
      const invalid of [{
        ...submission,
        payload: '{"reason":"PRIVATE_REPORT_MARKER",',
      }, { ...submission, semanticKey: '["report","PRIVATE_REPORT_MARKER",' }]
    ) {
      const error = await assertRejects(
        () => importReportOperation(ed, invalid, check),
        Error,
      );
      assertEquals(error.message, 'invalid report fact');
    }
    const forged = {
      ...resolution,
      source: f.node.node,
      incarnation: f.node.incarnation,
    };
    await assertRejects(
      () => importReportOperation(ed, forged, check),
      Error,
      'invalid report resolution',
    );
    assertEquals((await listReports(ed)).reports.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: source and import roll back their facts with the owned row', async () => {
  const f = await fixture();
  try {
    const hd = await f.home.server(), ed = await f.edge.server();
    await ed.exec(
      "CREATE TRIGGER report_fail BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT,'report rollback'); END",
    );
    await assertRejects(() =>
      storeReport(ed, {
        kind: 'room',
        reporter: '@alice:logical.test',
        roomId: '!r:logical.test',
        reason: '',
      })
    );
    assertEquals(
      await ed.query("SELECT * FROM domain_operations WHERE kind='report'"),
      [],
    );
    await storeReport(hd, {
      kind: 'room',
      reporter: '@alice:logical.test',
      roomId: '!r:logical.test',
      reason: '',
    });
    const fact = (await hd.tx((conn) =>
      reportOperations(conn, '@alice:logical.test')
    ))[0];
    await assertRejects(() => importReportOperation(ed, fact, async () => {}));
    assertEquals(
      await ed.query("SELECT * FROM domain_operations WHERE kind='report'"),
      [],
    );
    await ed.exec('DROP TRIGGER report_fail');
    await importReportOperation(ed, fact, async () => {});
    assertEquals((await listReports(ed)).reports.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: legacy home capture keeps original received and resolution cuts', async () => {
  const f = await fixture();
  try {
    const hd = await f.home.server();
    await hd.execute(
      "INSERT INTO reports(kind,reporter,user_id,reason,received_ms,resolved_ms,resolution) VALUES('user',?,?,?,?,?,?)",
      [
        '@alice:logical.test',
        '@bob:logical.test',
        'old private reason',
        10,
        20,
        'old resolution',
      ],
    );
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(records);
    const row = (await listReports(await f.edge.server())).reports[0];
    assertEquals([row.receivedMs, row.resolvedMs, row.resolution], [
      10,
      20,
      'old resolution',
    ]);
    const before = await hd.tx((conn) =>
      reportOperations(conn, '@alice:logical.test')
    );
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    assertEquals(
      await hd.tx((conn) => reportOperations(conn, '@alice:logical.test')),
      before,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade reports: resolution export failure rolls back its local result', async () => {
  const f = await fixture();
  try {
    const db = await f.home.server();
    await storeReport(db, {
      kind: 'room',
      reporter: '@alice:logical.test',
      roomId: '!r:logical.test',
      reason: 'retained',
    });
    await db.exec(
      "CREATE TRIGGER resolution_fail BEFORE INSERT ON domain_operations WHEN NEW.kind='report-resolution' BEGIN SELECT RAISE(ABORT,'resolution rollback'); END",
    );
    await assertRejects(() => resolveReport(db, 1, 'must roll back'));
    assertEquals((await listReports(db)).reports[0].resolvedMs, null);
    assertEquals(
      await db.query(
        "SELECT * FROM domain_operations WHERE kind='report-resolution'",
      ),
      [],
    );
    await db.exec('DROP TRIGGER resolution_fail');
    assertEquals(
      (await resolveReport(db, 1, 'committed')).resolution,
      'committed',
    );
  } finally {
    await f.close();
  }
});

Deno.test('directory scope retains selected local initiation without hiding unapplied home cuts', async (t) => {
  for (const mode of ['create', 'stock join']) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        setConfigForTests({ facade: { phase: 'f2' } });
        const server = await f.edge.server();
        const owner = new DirectoryReplicas(server, f.fp, 'logical.test');
        const inventory = await exportDirectoryReplica(
          f.home,
          f.ht,
          f.node.node,
          f.bundle.id,
        );
        if (!inventory) throw new Error('missing initial directory');
        await f.ej.receive('home', [inventory]);
        await owner.apply(f.ej, inventory);
        // F1 inventories cannot prove an F2 membership scope complete. Preserve
        // that refusal, then install the real explicit empty bootstraps before
        // exercising local room initiation under an F2 inventory.
        await assertRejects(
          () => owner.scopeState('rooms'),
          MatrixError,
          'replica unavailable',
        );
        const memberships = new MembershipOperations(f.home, f.ht, f.hp);
        for (const localpart of ['alice', 'bob']) {
          // Alice's selected auth head is already delivered by fixture(). Do
          // not append and skip a new head before its later suffix-hole probe.
          if (localpart === 'bob') {
            await exportAccountAuth(
              f.home,
              f.ht,
              f.hp,
              f.bundle.id,
              localpart,
              false,
            );
          }
          await memberships.bootstrap(localpart, f.bundle.id);
        }
        const complete = await exportDirectoryReplica(
          f.home,
          f.ht,
          f.node.node,
          f.bundle.id,
          2,
        );
        if (!complete) throw new Error('missing F2 directory');
        await f.ej.receive('home', [complete]);
        await owner.apply(f.ej, complete);
        const signer = await testSigner('logical.test');
        let roomId: string;
        if (mode === 'create') {
          roomId = (await createRoom(f.edge, {
            creator: '@alice:logical.test',
            preset: 'public_chat',
          }, signer)).roomId;
        } else {
          const source = await makeFakeRoom({ roomId: '!stock:remote.test' });
          const { fetcher } = fakeFetcher({
            makeJoin: (user) => source.makeJoinAnswer(user),
            sendJoin: (event) => source.acceptSendJoin(event),
          });
          roomId = (await joinRemote(f.edge, {
            roomId: source.roomId,
            user: '@alice:logical.test',
            via: [source.server.name],
            signer,
            deps: {
              self: 'logical.test',
              keys: fakeKeyResolver(
                source.server,
                await testRemoteServer('logical.test'),
              ),
              fetcher,
            },
          })).roomId;
        }
        await recoverServer(f.edge);
        assertEquals(await owner.scopeState('room:' + roomId), 'ready');
        const admission = await owner.prepareRoomScope(roomId);
        await server.tx(admission.check);
        assertEquals(await owner.scopeState('rooms'), 'ready');
        assertEquals((await owner.snapshot())?.rooms, []);
        setConfigForTests({ facade: { phase: 'f1' } });
        assertEquals(await owner.scopeState('room:' + roomId), 'absent');
        setConfigForTests({ facade: { phase: 'f2' } });
        const refreshedAuth = await exportAccountAuth(
          f.home,
          f.ht,
          f.hp,
          f.bundle.id,
          'alice',
          false,
        );
        await f.ej.receive('home', [refreshedAuth]);
        assertThrows(
          admission.checkCurrent,
          MatrixError,
          'replica unavailable',
        );
        await assertRejects(
          () => owner.scopeState('room:' + roomId),
          MatrixError,
          'replica unavailable',
        );
        await assertRejects(
          () => owner.scopeState('rooms'),
          MatrixError,
          'replica unavailable',
        );
        await new AccountSnapshots(f.edge, f.et, f.fp, f.owners).apply(
          f.ej,
          refreshedAuth,
        );
        assertEquals(await owner.scopeState('room:' + roomId), 'ready');
        const control = await exportOwnerControl(
          f.home,
          f.ht,
          f.hp,
          f.bundle.id,
        );
        const repeatedControl = await (await f.home.server()).tx((conn) =>
          appendRecord(conn, f.node.node, {
            source: control.source,
            incarnation: control.incarnation,
            stream: control.stream,
            type: control.type,
            version: control.version,
            operationId: 'scope-control-replay',
            payload: control.payload,
          })
        );
        const beforeControl = await owner.prepareRoomScope(roomId);
        await f.ej.receive('home', [repeatedControl]);
        assertThrows(
          beforeControl.checkCurrent,
          MatrixError,
          'replica unavailable',
        );
        await assertRejects(
          () => owner.scopeState('room:' + roomId),
          MatrixError,
          'replica unavailable',
        );
        await f.owners.apply(f.ej, repeatedControl);
        assertEquals(await owner.scopeState('room:' + roomId), 'ready');
        const currentAdmission = await owner.prepareRoomScope(roomId);
        const unselected = await createRoom(f.edge, {
          creator: '@bob:logical.test',
          preset: 'public_chat',
        }, signer);
        const received = await makeFakeRoom({
          roomId: '!received:logical.test',
          creator: '@alice:logical.test',
          server: await makeRemoteServer('logical.test'),
        });
        const events = [...received.events.values()];
        await importReplicaGenesis(f.edge, {
          roomId: received.roomId,
          roomVersion: received.version,
          self: 'logical.test',
          keys: fakeKeyResolver(received.server),
          create: events[0],
          join: events[1],
        });
        await recoverServer(f.edge);
        for (
          const id of [
            unselected.roomId,
            received.roomId,
            '!arbitrary:logical.test',
          ]
        ) {
          assertEquals(await owner.scopeState('room:' + id), 'absent');
        }
        // The same old home inventory still cannot erase the authorized local fact.
        await f.ej.receive('home', [inventory]);
        assertEquals(await owner.scopeState('room:' + roomId), 'ready');
        const room = await openRoom(f.edge, roomId);
        const reverse = await exportRoomReplica(
          f.edge,
          room,
          'logical.test',
          'home',
          f.bundle.id,
        );
        if (!reverse) throw new Error('missing reverse bootstrap');
        const pending = await (await f.home.server()).tx((conn) =>
          appendRecord(conn, f.node.node, {
            source: 'home',
            incarnation: f.bundle.id,
            stream: reverse.stream,
            type: reverse.type,
            version: reverse.version,
            operationId: 'home-cut',
            payload: reverse.payload,
          })
        );
        await f.ej.receive('home', [pending]);
        await assertRejects(
          () => owner.scopeState('room:' + roomId),
          MatrixError,
          'replica unavailable',
        );
        await assertRejects(
          () => owner.scopeState('rooms'),
          MatrixError,
          'replica unavailable',
        );
        assertThrows(
          currentAdmission.checkCurrent,
          MatrixError,
          'replica unavailable',
        );
        const independent = await createRoom(f.edge, {
          creator: '@alice:logical.test',
          preset: 'public_chat',
        }, signer);
        await recoverServer(f.edge);
        assertEquals(
          await owner.scopeState('room:' + independent.roomId),
          'ready',
        );
        await f.edge.close();
        const reopened = await f.open('edge');
        try {
          const pairings = new Pairings(
            await reopened.server(),
            f.node.signer(),
            f.node.publicKey,
            'b'.repeat(64),
            f.node,
          );
          const cold = new DirectoryReplicas(
            await reopened.server(),
            pairings,
            'logical.test',
          );
          await assertRejects(
            () => cold.scopeState('room:' + roomId),
            MatrixError,
            'replica unavailable',
          );
          // A different selected local room stays ready across the same reopen;
          // the pending home stream fences only its own room.
          await recoverServer(reopened);
          assertEquals(
            await cold.scopeState('room:' + independent.roomId),
            'ready',
          );
        } finally {
          await reopened.close();
        }
      } finally {
        await f.close();
        setConfigForTests({});
      }
    });
  }
});

Deno.test('domain filters: signed bootstrap and suffix preserve immutable objects in both directions', async () => {
  const f = await fixture();
  try {
    await f.ht.tx((tx) =>
      tx.filters.insert('alice', '7', '{"room":{"timeline":{"limit":7}}}')
    );
    const id = await storeFilter(f.ht, 'alice', {
      room: { timeline: { limit: 1 } },
    });
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(records);
    assertEquals(await loadFilter(f.et, 'alice', '7'), {
      room: { timeline: { limit: 7 } },
    });
    assertEquals(await loadFilter(f.et, 'alice', id), {
      room: { timeline: { limit: 1 } },
    });
    const edgeId = await storeFilter(f.et, 'alice', {
      room: { timeline: { limit: 2 } },
    });
    for (const record of await f.es.export('alice')) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(await loadFilter(f.ht, 'alice', edgeId), {
      room: { timeline: { limit: 2 } },
    });
    const before = await f.et.tx((tx) => tx.streams.heads());
    const homeCut = Math.max(...records.map((record) => record.sequence));
    const suffixId = await storeFilter(f.ht, 'alice', {
      account_data: { types: ['m.direct'] },
    });
    const suffix = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > homeCut
    );
    await f.toEdge(suffix);
    await f.toEdge(suffix);
    assertEquals(await loadFilter(f.et, 'alice', suffixId), {
      account_data: { types: ['m.direct'] },
    });
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const server = await reopened.server();
      const node = await loadNode(server, 'logical.test', 'edge_a');
      const pairings = new Pairings(
        server,
        node.signer(),
        node.publicKey,
        'b'.repeat(64),
        node,
      );
      const tenant = await enrolledTenant(
        reopened,
        pairings,
        'logical.test',
        'edge_a',
      );
      assertEquals(await loadFilter(tenant, 'alice', suffixId), {
        account_data: { types: ['m.direct'] },
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('domain filters: old signed domain bootstrap cannot prove the new filter scope complete', async () => {
  const f = await fixture();
  try {
    const records = structuredClone(await f.hs.bootstrap('alice', f.bundle.id));
    const last = records.at(-1)!;
    const payload = last.payload as {
      body: DomainBootstrap & { filters?: unknown };
      signature: string;
    };
    delete payload.body.filters;
    payload.signature = await f.ht.signer().sign(canonicalJson(payload.body));
    last.operationId = 'domain-bootstrap:' +
      createHash('sha256').update(canonicalJson(payload.body)).digest('hex');
    last.hash = recordHash({
      source: last.source,
      incarnation: last.incarnation,
      stream: last.stream,
      sequence: last.sequence,
      type: last.type,
      version: last.version,
      operationId: last.operationId,
      previous: last.previous,
      payload: last.payload,
    });
    await f.toEdge(records);
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), null);
    await assertRejects(
      () => loadFilter(tenant, 'alice', '7'),
      MatrixError,
      'domain snapshot unavailable',
    );
  } finally {
    await f.close();
  }
});

async function completeOpenIdInventory(f: Awaited<ReturnType<typeof fixture>>) {
  const auth = await exportAccountAuth(
    f.home,
    f.ht,
    f.hp,
    f.bundle.id,
    'bob',
    false,
  );
  await f.ej.receive('home', [auth]);
  await new AccountSnapshots(f.edge, f.et, f.fp, f.owners).apply(f.ej, auth);
  await f.toEdge(await f.hs.bootstrap('bob', f.bundle.id));
  const directory = await exportDirectoryReplica(
    f.home,
    f.ht,
    f.node.node,
    f.bundle.id,
  );
  if (!directory) throw new Error('missing initial directory');
  await f.ej.receive('home', [directory]);
  await new DirectoryReplicas(await f.edge.server(), f.fp, 'logical.test')
    .apply(f.ej, directory);
}

Deno.test('domain OpenID: signed bootstrap captures legacy digests and suffix imports keep the original issuer', async () => {
  const f = await fixture();
  try {
    const now = Date.now(), legacy = '7'.repeat(64);
    const legacyHash = await hashToken(legacy);
    await f.ht.tx((tx) => tx.openid.insert(legacyHash, 'alice', now + 3600000));
    const issued = await issueOpenIdToken(f.ht, 'alice', now);
    const baseline = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(baseline);
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    for (const token of [legacy, issued.access_token]) {
      assertEquals(await openIdUserInfo(tenant, token, now), {
        sub: '@alice:logical.test',
      });
      assertEquals(await lookupToken(f.et, token), null);
    }
    const edgeToken = await issueOpenIdToken(tenant, 'alice', now);
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const record of await f.es.export('alice')) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(await openIdUserInfo(f.ht, edgeToken.access_token, now), {
      sub: '@alice:logical.test',
    });
    const homeCut = Math.max(...baseline.map((record) => record.sequence));
    const suffix = await issueOpenIdToken(f.ht, 'alice', now);
    const records = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > homeCut
    );
    await f.toEdge(records);
    await f.toEdge(records);
    assertEquals(await openIdUserInfo(tenant, suffix.access_token, now), {
      sub: '@alice:logical.test',
    });
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    await completeOpenIdInventory(f);
    const unknown = await assertRejects(
      () => openIdUserInfo(tenant, 'not-a-token'),
      MatrixError,
    );
    assertEquals(unknown.errcode, 'M_UNKNOWN_TOKEN');
    const exported = await f.hs.export('alice', f.bundle.id);
    assertEquals(
      exported.some((record) => {
        const body = (record.payload as { body: DomainOperation }).body;
        return body.kind === 'domain-operation' &&
          body.operation.source === f.node.node;
      }),
      false,
    );
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const coldNode = await loadNode(
        await reopened.server(),
        'logical.test',
        'edge_a',
      );
      const pairings = new Pairings(
        await reopened.server(),
        coldNode.signer(),
        coldNode.publicKey,
        'b'.repeat(64),
        coldNode,
      );
      const cold = await enrolledTenant(
        reopened,
        pairings,
        'logical.test',
        'edge_a',
      );
      for (
        const token of [
          legacy,
          issued.access_token,
          edgeToken.access_token,
          suffix.access_token,
        ]
      ) {
        assertEquals(await openIdUserInfo(cold, token, now), {
          sub: '@alice:logical.test',
        });
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('domain OpenID: older bootstrap does not prove missing legacy credentials absent or enable issuance', async () => {
  const f = await fixture();
  try {
    await completeOpenIdInventory(f);
    const records = structuredClone(await f.hs.bootstrap('alice', f.bundle.id));
    const last = records.at(-1)!;
    const payload = last.payload as {
      body: DomainBootstrap;
      signature: string;
    };
    delete payload.body.openid;
    payload.signature = await f.ht.signer().sign(canonicalJson(payload.body));
    last.operationId = 'domain-bootstrap:' +
      createHash('sha256').update(canonicalJson(payload.body)).digest('hex');
    last.hash = recordHash({
      source: last.source,
      incarnation: last.incarnation,
      stream: last.stream,
      sequence: last.sequence,
      type: last.type,
      version: last.version,
      operationId: last.operationId,
      previous: last.previous,
      payload: last.payload,
    });
    await f.toEdge(records);
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    for (
      const operation of [
        () => openIdUserInfo(tenant, '7'.repeat(64)),
        () => issueOpenIdToken(tenant, 'alice'),
      ]
    ) {
      const error = await assertRejects(operation, MatrixError);
      assertEquals(error.status, 503);
      assertEquals(error.errcode, 'M_UNAVAILABLE');
    }
    assertEquals(await f.et.tx((tx) => tx.openid.operations('alice')), []);
  } finally {
    await f.close();
  }
});

Deno.test('domain OpenID: unseen selected account and later inventory receipt cannot prove bearer absence', async () => {
  const f = await fixture();
  try {
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    const directory = await exportDirectoryReplica(
      f.home,
      f.ht,
      f.node.node,
      f.bundle.id,
    );
    if (!directory) throw new Error('missing initial directory');
    await f.ej.receive('home', [directory]);
    await new DirectoryReplicas(await f.edge.server(), f.fp, 'logical.test')
      .apply(f.ej, directory);
    const authority = new FacadeAuth(
      await f.edge.server(),
      f.fp,
      f.node,
      new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
      {
        replicatecredentials: false,
        allowstaleauth: false,
        authmaxstalehours: 1,
      },
    );
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      authority,
    );
    const legacy = '6'.repeat(64),
      hash = await hashToken(legacy),
      now = Date.now();
    await f.ht.tx((tx) => tx.openid.insert(hash, 'bob', now + 3600000));
    const pending = await assertRejects(
      () => openIdUserInfo(tenant, legacy, now),
      MatrixError,
    );
    assertEquals(
      pending.status,
      503,
      'selected Bob has not supplied his private inventory',
    );
    const auth = await exportAccountAuth(
      f.home,
      f.ht,
      f.hp,
      f.bundle.id,
      'bob',
      false,
    );
    await f.ej.receive('home', [auth]);
    await new AccountSnapshots(f.edge, f.et, f.fp, f.owners).apply(f.ej, auth);
    await f.toEdge(await f.hs.bootstrap('bob', f.bundle.id));
    assertEquals(await openIdUserInfo(tenant, legacy, now), {
      sub: '@bob:logical.test',
    });
    const unknown = await assertRejects(
      () => openIdUserInfo(tenant, 'not-a-token'),
      MatrixError,
    );
    assertEquals(unknown.errcode, 'M_UNKNOWN_TOKEN');
    const prepared = await authority.prepare();
    const received = await (await f.home.server()).tx((conn) =>
      appendRecord(conn, f.node.node, {
        source: directory.source,
        incarnation: directory.incarnation,
        stream: directory.stream,
        type: directory.type,
        version: directory.version,
        operationId: 'openid-inventory-receive',
        payload: directory.payload,
      })
    );
    await f.ej.receive('home', [received]);
    const invalidated = await assertRejects(
      () =>
        (f.edge.tenant('logical.test')).then((db) =>
          db.tx((conn) =>
            prepared.check(conn, { kind: 'openid', hash: '0'.repeat(64) })
          )
        ),
      MatrixError,
    );
    assertEquals(
      invalidated.status,
      503,
      'a newly received directory invalidates prepared absence',
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain backup: signed home revisions retain ciphertext, exact etags, deletes and consumer availability', async () => {
  const f = await fixture();
  const metadata = {
    algorithm: 'opaque',
    auth_data: { key: 'public', extension: 0.5 },
  };
  const data = {
    first_message_index: 2,
    forwarded_count: 0,
    is_verified: false,
    session_data: { ciphertext: 'private-ciphertext' },
  };
  try {
    await f.ht.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    await f.ht.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!backup:logical.test', 's', data)
    );
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
      { ...metadata, version: '1', count: 1, etag: '1' },
    );
    assertEquals(
      await tenant.tx((tx) =>
        tx.keyBackup.keys('alice', 'get', '1', '!backup:logical.test', 's')
      ),
      data,
    );
    const absent = await assertRejects(
      () => tenant.tx((tx) => tx.keyBackup.version('alice', 'get', '999')),
      MatrixError,
    );
    assertEquals(absent.status, 404);
    const before = await tenant.tx((tx) => tx.streams.heads());
    const previous = Math.max(
      ...(await f.hs.export('alice', f.bundle.id)).map((record) =>
        record.sequence
      ),
    );
    await f.ht.tx((tx) =>
      tx.keyBackup.keys('alice', 'delete', '1', '!backup:logical.test', 's')
    );
    const suffix = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > previous
    );
    await f.ej.receive('home', suffix);
    const pending = await assertRejects(
      () => tenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
      MatrixError,
    );
    assertEquals(pending.status, 503);
    for (const record of suffix) await f.es.apply(f.ej, record);
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
      { ...metadata, version: '1', count: 0, etag: '2' },
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
      { rooms: {} },
    );
    await f.toEdge(suffix);
    assertEquals(await tenant.tx((tx) => tx.streams.heads()), before);
    // Original home dots are retained, never echoed as facade authorship.
    assertEquals(
      (await f.es.export('alice')).filter((record) =>
        (record.payload as { body: DomainOperation }).body.operation.kind ===
          'backup'
      ),
      [],
    );
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const node = await loadNode(
        await reopened.server(),
        'logical.test',
        'edge_a',
      );
      const pairing = new Pairings(
        await reopened.server(),
        node.signer(),
        node.publicKey,
        'b'.repeat(64),
        node,
      );
      const reopenedTenant = await enrolledTenant(
        reopened,
        pairing,
        'logical.test',
        'edge_a',
      );
      assertEquals(
        await reopenedTenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
        { ...metadata, version: '1', count: 0, etag: '2' },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('domain backup: legacy home versions are captured but older signed manifests cannot prove inventory', async () => {
  const f = await fixture();
  try {
    await (await f.home.tenant('logical.test')).tx((conn) =>
      conn.execute(
        'INSERT INTO backup_versions(localpart,version_no,algorithm,auth_data,etag,deleted) VALUES(?,?,?,?,?,0)',
        ['alice', 7, 'legacy', '{"key":"legacy-public"}', 4],
      )
    );
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(records);
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
      {
        version: '7',
        algorithm: 'legacy',
        auth_data: { key: 'legacy-public' },
        etag: '4',
        count: 0,
      },
    );
    const original = records.at(-1)!;
    const payload = structuredClone(original.payload) as {
      body: DomainBootstrap;
      signature: string;
    };
    delete payload.body.backups;
    payload.signature = await f.ht.signer().sign(canonicalJson(payload.body));
    const legacy = await appendRecordForBackup(f, payload);
    await f.toEdge([legacy]);
    const unavailable = await assertRejects(
      () => tenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
      MatrixError,
    );
    assertEquals(unavailable.status, 503);
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), null);
  } finally {
    await f.close();
  }
});

async function appendRecordForBackup(
  f: Awaited<ReturnType<typeof fixture>>,
  payload: { body: DomainBootstrap; signature: string },
) {
  return await (await f.home.server()).tx((conn) =>
    appendRecord(conn, f.node.node, {
      source: 'home',
      incarnation: f.bundle.id,
      stream: 'domain:@alice:logical.test',
      type: 'domain-operation',
      version: 1,
      operationId: 'domain-bootstrap:' +
        createHash('sha256').update(canonicalJson(payload.body)).digest('hex'),
      payload,
    })
  );
}

Deno.test('domain link: semantic operations have an explicitly negotiated reader', () => {
  assertEquals(
    LINK_SUPPORTED.some((item) =>
      item.type === 'domain-operation' && item.version === 1
    ),
    true,
  );
});

Deno.test('domain link: user-facing register owners require complete domain bootstrap, independently of password availability', async () => {
  const f = await fixture();
  try {
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    const intents = [
      () => getAccountData(tenant, 'alice', '', 'm.direct'),
      () => getPublicProfile(tenant, 'alice'),
      () => rulesetFor(tenant, 'alice'),
      () =>
        putAccountData(tenant, 'alice', '', 'm.direct', { protected: true }),
      () => updateRoomTag(tenant, 'alice', '!r:logical.test', 'work', {}),
      () => setProfileField(tenant, 'alice', 'org.example.field', 'value'),
      () => setDisplayName(tenant, 'alice', 'guarded legacy name'),
      () => setAvatarUrl(tenant, 'alice', 'mxc://logical.test/guarded'),
      () => setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true),
    ];
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const intent of intents) {
      await assertRejects(intent, MatrixError, 'domain snapshot unavailable');
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    assertEquals(await f.et.tx((tx) => tx.accountData.operations('alice')), []);
    assertEquals(await f.et.tx((tx) => tx.profiles.operations('alice')), []);
    assertEquals(await f.et.tx((tx) => tx.pushRules.operations('alice')), []);

    const bootstrap = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(bootstrap);
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), null);
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.displayname,
      'Alice',
    );
    assertEquals(
      await rulesetFor(tenant, 'alice'),
      await rulesetFor(f.ht, 'alice'),
    );
    await putAccountData(tenant, 'alice', '', 'm.direct', {
      after: 'complete',
    });
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), {
      after: 'complete',
    });
    await updateRoomTag(tenant, 'alice', '!r:logical.test', 'work', {
      order: 0.5,
    });
    assertEquals(
      await getAccountData(tenant, 'alice', '!r:logical.test', 'm.tag'),
      { tags: { work: { order: 0.5 } } },
    );
    await setProfileField(tenant, 'alice', 'org.example.field', 'value');
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.['org.example.field'],
      'value',
    );
    await setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true);
    assertEquals((await rulesetFor(tenant, 'alice')).override[0].enabled, true);

    await putAccountData(f.ht, 'alice', '', 'm.direct', { suffix: true });
    const cut = Math.max(...bootstrap.map((record) => record.sequence));
    const suffix = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > cut
    );
    await f.ej.receive('home', suffix);
    await assertRejects(
      () => getAccountData(tenant, 'alice', '', 'm.direct'),
      MatrixError,
      'domain snapshot unavailable',
    );
    for (const record of suffix) await f.es.apply(f.ej, record);
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), {
      suffix: true,
    });
  } finally {
    await f.close();
  }
});

Deno.test('domain admission: retained preparations refuse a newly received suffix at every register owner', async () => {
  const f = await fixture();
  try {
    const bootstrap = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(bootstrap);
    const authority = new FacadeAuth(
      await f.edge.server(),
      f.fp,
      f.node,
      new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
      {
        replicatecredentials: false,
        allowstaleauth: false,
        authmaxstalehours: 1,
      },
    );
    const prepared = await authority.prepare();
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      prepared,
    );
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), null);
    await putAccountData(f.ht, 'alice', '', 'm.direct', { pending: true });
    const cut = Math.max(...bootstrap.map((record) => record.sequence));
    const suffix = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > cut
    );
    assertEquals(suffix.length > 0, true);
    await f.ej.receive('home', suffix);
    const intents = [
      () => getAccountData(tenant, 'alice', '', 'm.direct'),
      () => getPublicProfile(tenant, 'alice'),
      () => rulesetFor(tenant, 'alice'),
      () => putAccountData(tenant, 'alice', '', 'm.direct', { stale: true }),
      () => updateRoomTag(tenant, 'alice', '!r:logical.test', 'work', {}),
      () => setProfileField(tenant, 'alice', 'org.example.field', 'stale'),
      () => setDisplayName(tenant, 'alice', 'stale name'),
      () => setAvatarUrl(tenant, 'alice', 'mxc://logical.test/stale'),
      () => setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true),
    ];
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const intent of intents) {
      await assertRejects(intent, MatrixError, 'domain snapshot unavailable');
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    for (const record of suffix) await f.es.apply(f.ej, record);
    // Application restores fresh admission, never the earlier retained cut.
    await assertRejects(intents[0], MatrixError, 'domain snapshot unavailable');
    const current = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      authority,
    );
    assertEquals(await getAccountData(current, 'alice', '', 'm.direct'), {
      pending: true,
    });
  } finally {
    await f.close();
  }
});

Deno.test('domain link: signed owner operations reconcile both directions without export echoes or duplicate news', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'protected',
      fraction: 0.25,
    });
    await putAccountData(f.ht, 'alice', '!r:logical.test', 'm.tag', {
      tags: { work: { order: 0.5 } },
    });
    await setProfileField(f.ht, 'alice', 'displayname', 'Home Alice');
    await f.capture();
    const sent = await f.hs.export('alice', f.bundle.id);
    assertEquals(
      [
        ...new Set(
          sent.map((record) =>
            (record.payload as { body: { operation: { kind: string } } }).body
              .operation.kind
          ),
        ),
      ].sort(),
      ['account-data', 'profile', 'push-rules', 'tags'],
    );
    await f.toEdge(sent);
    assertEquals(
      await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'protected', fraction: 0.25 },
    );
    assertEquals(
      await f.et.tx((tx) => tx.profiles.get('alice')).then((p) =>
        p?.displayname
      ),
      'Home Alice',
    );
    assertEquals(await f.es.export('alice'), []);
    assertEquals(await f.hs.export('alice', f.bundle.id), sent);
    const news = await f.et.tx((tx) => tx.streams.heads());
    // Simulate the crash window AFTER the semantic owner committed but BEFORE
    // the server journal's applied receipt. Replay must not stamp new news.
    await (await f.edge.server()).execute(
      "UPDATE facade_streams SET applied=0,applied_hash='' WHERE direction='in' AND stream=?",
      [sent[0].stream],
    );
    await (await f.edge.server()).execute(
      "UPDATE facade_records SET result_json=NULL WHERE direction='in' AND stream=?",
      [sent[0].stream],
    );
    for (const record of sent) {
      assertEquals(await f.es.apply(f.ej, record), true);
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), news);
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'edge-winner',
    });
    await setProfileField(f.et, 'alice', 'displayname', 'Edge Alice');
    const reverse = await f.es.export('alice');
    assertEquals(reverse.length, 2);
    for (const record of reverse) {
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(
      await getAccountData(f.ht, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'edge-winner' },
    );
    assertEquals(
      await f.ht.tx((tx) => tx.profiles.get('alice')).then((p) =>
        p?.displayname
      ),
      'Edge Alice',
    );
    assertEquals(await f.hs.export('alice', f.bundle.id), sent);
    const old = new Journal(await f.edge.server(), LINK_CAPABILITIES);
    await assertRejects(
      () => old.receive('home', [sent[0]]),
      LinkError,
      'unsupported record type',
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain link: source admission is durable even before receiver receipt evidence arrives', async () => {
  const f = await fixture();
  try {
    await (await f.home.server()).tx((conn) =>
      recordReceiptOperation(conn, {
        roomId: '!r:logical.test',
        userId: '@alice:logical.test',
        receiptType: 'm.read.private',
        threadId: null,
        eventIds: ['$target'],
        ts: 1,
        admission: { membershipEvent: '$original-join' },
      })
    );
    const sent = await f.hs.export('alice', f.bundle.id);
    assertEquals(sent.length, 1);
    await f.toEdge(sent);
    const rows = await (await f.edge.server()).tx((conn) =>
      receiptOperations(conn, '@alice:logical.test')
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].kind, 'receipt');
    assertEquals(
      await (await f.edge.server()).query(
        "SELECT applied FROM domain_operations WHERE kind='receipt'",
      ),
      [{ applied: 0 }],
    );
    assertEquals((await f.ej.heads('home', 'in', sent[0])).applied.sequence, 1);
    assertEquals(await f.es.export('alice'), []);
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      assertEquals(
        await (await reopened.server()).tx((conn) =>
          receiptOperations(conn, '@alice:logical.test')
        ),
        rows,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('domain link: rejects forged signatures, source, grant, account and future control before ACK', async (t) => {
  for (
    const fault of [
      'signature',
      'source',
      'grant',
      'account',
      'future-control',
      'revoked',
    ]
  ) {
    await t.step(fault, async () => {
      const f = await fixture();
      try {
        await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
          ciphertext: 'protected',
        });
        const [original] = await f.hs.export('alice', f.bundle.id);
        const record = structuredClone(original);
        const payload = record.payload as {
          body: Record<string, unknown> & {
            operation: { operationId: string; source: string };
          };
          signature: string;
        };
        if (fault === 'source') {
          payload.body.source = payload.body.operation.source = 'edge_a';
        }
        if (fault === 'grant') payload.body.grantRevision = 99;
        if (fault === 'account') payload.body.localpart = 'bob';
        if (fault === 'future-control') payload.body.ownerRevision = 99;
        if (fault !== 'signature') {
          payload.signature = await f.ht.signer().sign(
            canonicalJson(payload.body),
          );
        } else payload.signature = 'A'.repeat(86);
        record.operationId = 'domain:' +
          createHash('sha256').update(
            canonicalJson([
              payload.body.pairing,
              payload.body.grantRevision,
              payload.body.ownerRevision,
              payload.body.operation.operationId,
            ]),
          ).digest('hex');
        record.hash = recordHash({
          source: record.source,
          incarnation: record.incarnation,
          stream: record.stream,
          sequence: record.sequence,
          type: record.type,
          version: record.version,
          operationId: record.operationId,
          previous: record.previous,
          payload: record.payload,
        });
        await f.ej.receive('home', [record]);
        if (fault === 'revoked') {
          await (await f.edge.server()).execute(
            "UPDATE facade_pairings SET state='revoked'",
          );
        }
        await assertRejects(() => f.es.apply(f.ej, record), LinkError);
        assertEquals(
          (await f.ej.heads('home', 'in', record)).applied.sequence,
          0,
        );
        assertEquals(
          await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
          null,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('domain link: selected account scope is required for export and reverse application', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'bob', '', 'm.secret_storage.key', {
      ciphertext: 'bob-only',
    });
    await assertRejects(
      () => f.hs.export('bob', f.bundle.id),
      LinkError,
      'not selected',
    );
    await f.toEdge(await f.hs.export('alice', f.bundle.id));
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'edge-only',
    });
    const [record] = await f.es.export('alice');
    await f.hj.receive('edge_a', [record]);
    await (await f.home.server()).execute(
      'DELETE FROM facade_exports WHERE scope=?',
      ['auth:@alice:logical.test'],
    );
    await assertRejects(
      () => f.hs.apply(f.hj, record, f.bundle.id),
      LinkError,
      'not selected',
    );
    assertEquals(
      (await f.hj.heads('edge_a', 'in', record)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain bootstrap: explicit complete owner cut enables scope only after all signed operations apply', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'complete-bootstrap',
    });
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    const marker = records.at(-1)!;
    const view = (marker.payload as { body: DomainBootstrap }).body;
    assertEquals(view.kind, 'domain-bootstrap');
    assertEquals(view.tenant.length >= 3, true);
    assertEquals(view.receipts, []);
    await f.toEdge(records.slice(0, -1));
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [],
    );
    await f.toEdge([marker]);
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready,source_cut FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [{ ready: 1, source_cut: marker.sequence }],
    );
    assertEquals(
      await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'complete-bootstrap' },
    );
    assertEquals(await f.hs.bootstrap('alice', f.bundle.id), records);
    assertEquals(await f.es.export('alice'), []);
    await assertRejects(
      () => f.es.bootstrap('alice', f.bundle.id),
      LinkError,
      'only home',
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain bootstrap: missing owner facts prevent readiness and ACK until authentic replay restores them', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'retained-fact',
    });
    const records = await f.hs.bootstrap('alice', f.bundle.id),
      marker = records.at(-1)!;
    await f.toEdge(records.slice(0, -1));
    const operation = (records.find((record) =>
      (record.payload as { body: DomainOperation }).body.operation?.kind ===
        'account-data'
    )!.payload as { body: DomainOperation }).body.operation;
    const db = await f.edge.tenant('logical.test');
    await db.execute('DELETE FROM domain_operations WHERE operation_id=?', [
      operation.operationId,
    ]);
    await f.ej.receive('home', [marker]);
    await assertRejects(
      () =>
        f.es.apply(f.ej, marker),
      LinkError,
      'awaits retained facts',
    );
    assertEquals(
      (await f.ej.heads('home', 'in', marker)).applied.sequence,
      marker.sequence - 1,
    );
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [],
    );
    const before = await f.et.tx((tx) => tx.streams.heads());
    await f.et.tx((tx) => tx.accountData.import(operation));
    assertEquals(await f.es.apply(f.ej, marker), true);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [{ ready: 1 }],
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain bootstrap review: home restores an authenticated facade-origin fact before declaring completeness', async () => {
  const f = await fixture();
  try {
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'facade-retained-by-home',
    });
    const reverse = await f.es.export('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(
      await getAccountData(f.ht, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'facade-retained-by-home' },
    );
    const operation = (reverse.find((record) =>
      (record.payload as { body: DomainOperation }).body.operation.kind ===
        'account-data'
    )!.payload as { body: DomainOperation }).body.operation;
    // Same missing-owner-fact boundary as the existing authentic-replay test,
    // but this fact was authored here and durably admitted at home.
    await (await f.edge.tenant('logical.test')).execute(
      'DELETE FROM domain_operations WHERE operation_id=?',
      [operation.operationId],
    );
    const bootstrap = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(bootstrap);
    assertEquals(
      (await f.et.tx((tx) =>
        tx.accountData.operations('alice')
      )).some((held) => held.operationId === operation.operationId),
      true,
    );
    assertEquals(
      await f.hs.export('alice', f.bundle.id),
      bootstrap.filter((record) =>
        (record.payload as { body: { kind: string } }).body.kind ===
          'domain-operation'
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain history: every owner restores original facts without new news or export echoes', async () => {
  const f = await fixture();
  try {
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'retained',
    });
    await putAccountData(f.et, 'alice', '!r:logical.test', 'm.tag', {
      tags: { edge: { order: 0.25 } },
    });
    await setProfileField(f.et, 'alice', 'displayname', 'Retained edge');
    await putRule(f.et, 'alice', 'override', 'edge', {
      actions: ['dont_notify'],
      conditions: [],
    }, {});
    await (await f.edge.server()).tx((conn) =>
      recordReceiptOperation(conn, {
        roomId: '!r:logical.test',
        userId: '@alice:logical.test',
        receiptType: 'm.read.private',
        threadId: null,
        eventIds: ['$pending-target'],
        ts: 1,
        admission: { membershipEvent: '$original-join' },
      })
    );
    const reverse = await f.es.export('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const operations = reverse.map((record) =>
      (record.payload as { body: DomainOperation }).body.operation
    );
    assertEquals([...new Set(operations.map((op) => op.kind))].sort(), [
      'account-data',
      'profile',
      'push-rules',
      'receipt',
      'tags',
    ]);
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const operation of operations) {
      await (await (operation.kind === 'receipt'
        ? f.edge.server()
        : f.edge.tenant('logical.test'))).execute(
          'DELETE FROM domain_operations WHERE operation_id=?',
          [operation.operationId],
        );
    }
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(records);
    const restored = [
      ...await f.et.tx(async (tx) => [
        ...await tx.accountData.operations('alice'),
        ...await tx.profiles.operations('alice'),
        ...await tx.pushRules.operations('alice'),
      ]),
      ...await (await f.edge.server()).tx((conn) =>
        receiptOperations(conn, '@alice:logical.test')
      ),
    ];
    for (const operation of operations) {
      assertEquals(
        restored.find((op) => op.operationId === operation.operationId),
        operation,
      );
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    assertEquals(await f.es.export('alice'), reverse);
    assertEquals(
      await (await f.edge.server()).query(
        "SELECT applied FROM domain_operations WHERE kind='receipt'",
      ),
      [{ applied: 0 }],
    );
    await f.toEdge(records);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
  } finally {
    await f.close();
  }
});

Deno.test('domain history: retained prior-incarnation context permits current successors but not fresh historical authorship', async () => {
  const f = await fixture();
  try {
    // A home-retained owner fact from an earlier enrollment. No current source
    // can author it; bootstrap must preserve that original identity and closure.
    const conn = await f.home.tenant('logical.test');
    const { operation: prior } = await conn.tx((tx) =>
      writeRegister(
        tx,
        { source: 'edge_a', incarnation: 'prior-authenticated-incarnation' },
        JSON.stringify(['account-data', 'alice', '', 'm.secret_storage.key']),
        'account-data',
        JSON.stringify({ ciphertext: 'old-retained' }),
      )
    );
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'home-successor',
    });
    // Ordinary export can precede the historical predecessor. Its signed
    // successor stays pending rather than blocking the journal before history.
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    assertEquals(
      await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'home-successor' },
    );
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'current-successor',
    });
    const reverse = await f.es.export('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(
      await getAccountData(f.ht, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'current-successor' },
    );
    const retained = (await f.et.tx((tx) => tx.accountData.operations('alice')))
      .find((op) => op.operationId === prior.operationId)!;
    await assertRejects(
      () => f.et.tx((tx) => tx.accountData.import(retained)),
      Error,
      'domain source unavailable',
    );
    // A structurally valid but unknown historical context is not authority.
    const { operation: forged } = await conn.tx((tx) =>
      writeRegister(
        tx,
        { source: 'edge_a', incarnation: 'never-admitted' },
        JSON.stringify(['account-data', 'alice', '', 'm.other']),
        'account-data',
        '{}',
      )
    );
    const { operation: next } = await conn.tx((tx) =>
      writeRegister(
        tx,
        { source: f.node.node, incarnation: f.node.incarnation },
        forged.semanticKey,
        'account-data',
        '{"next":true}',
      )
    );
    const before = await f.et.tx((tx) => tx.streams.heads());
    await f.et.tx((tx) => tx.accountData.import(next));
    assertEquals(await getAccountData(f.et, 'alice', '', 'm.other'), null);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    // Persisting an unrelated stream's dot cannot authenticate this predecessor.
    await (await f.edge.tenant('logical.test')).tx((tx) =>
      importRegisterOperation(tx, {
        ...forged,
        semanticKey: JSON.stringify([
          'account-data',
          'alice',
          '',
          'm.unrelated',
        ]),
        stream: 'register:' +
          JSON.stringify(['account-data', 'alice', '', 'm.unrelated']),
        operationId: JSON.stringify([
          forged.source,
          forged.incarnation,
          'register:' +
          JSON.stringify(['account-data', 'alice', '', 'm.unrelated']),
          forged.sequence,
        ]),
      })
    );
    await f.et.tx((tx) => tx.accountData.import(next));
    assertEquals(await getAccountData(f.et, 'alice', '', 'm.other'), null);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
  } finally {
    await f.close();
  }
});

Deno.test('domain history: authenticated current home, account and control bindings precede owner import and ACK', async (t) => {
  for (
    const fault of [
      'signature',
      'payload',
      'account',
      'grant',
      'future-control',
      'source',
      'ordinary-echo',
    ]
  ) {
    await t.step(fault, async () => {
      const f = await fixture();
      try {
        await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
        await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
          ciphertext: 'retained',
        });
        for (const record of await f.es.export('alice')) {
          await f.hj.receive(f.node.node, [record]);
          await f.hs.apply(f.hj, record, f.bundle.id);
        }
        const records = await f.hs.bootstrap('alice', f.bundle.id);
        const original = records.find((r) =>
          (r.payload as { body: { kind: string } }).body.kind ===
            'domain-history'
        )!;
        const record = structuredClone(original);
        const payload = record.payload as {
          body:
            | DomainOperation
            | import('#engine/facade/domain-control.ts').DomainHistory;
          signature: string;
        };
        if (fault === 'account') payload.body.localpart = 'bob';
        if (fault === 'grant') payload.body.grantRevision++;
        if (fault === 'future-control') payload.body.ownerRevision = 99;
        if (fault === 'source') payload.body.source = 'edge_a';
        if (fault === 'ordinary-echo') payload.body.kind = 'domain-operation';
        if (fault !== 'signature') {
          payload.signature = await f.ht.signer().sign(
            canonicalJson(payload.body),
          );
        } else payload.signature = 'A'.repeat(86);
        if (fault === 'payload') {
          payload.body.operation.payload = '{"ciphertext":"substituted"}';
        }
        record.operationId = (payload.body.kind === 'domain-history'
          ? 'domain-history:'
          : 'domain:') +
          createHash('sha256').update(
            canonicalJson([
              payload.body.pairing,
              payload.body.grantRevision,
              payload.body.ownerRevision,
              payload.body.operation.operationId,
            ]),
          ).digest('hex');
        record.hash = recordHash({
          source: record.source,
          incarnation: record.incarnation,
          stream: record.stream,
          sequence: record.sequence,
          type: record.type,
          version: record.version,
          operationId: record.operationId,
          previous: record.previous,
          payload: record.payload,
        });
        await f.ej.receive('home', [record]);
        const before = await f.ej.heads('home', 'in', record);
        await assertRejects(() =>
          f.es.apply(f.ej, record), LinkError);
        assertEquals(
          (await f.ej.heads('home', 'in', record)).applied,
          before.applied,
        );
        assertEquals(
          await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
          { ciphertext: 'retained' },
        );
      } finally {
        await f.close();
      }
    });
  }
});
