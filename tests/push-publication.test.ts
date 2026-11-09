import { assert, assertEquals, assertRejects } from '@std/assert';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { openStore } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  project,
  sourceOf,
  withProjectionLock,
} from '#engine/server/project.ts';
import { get } from '#engine/store/watermark.ts';
import {
  advanceNotificationRead,
  notificationSnapshot,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';

Deno.test('push publication: v13 migration preserves old feed and receipts without historical notification flood; rollback and replay are exact', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, {
    schemas: {
      room: roomSchema,
      tenant: tenantSchema,
      server: { version: 13, apply: (db) => db.exec(SERVER_V13) },
    },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!push-upgrade:test' });
    await bobJoins(g);
    const old = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'old', msgtype: 'm.text' },
    }, g.signer);
    const changes = await g.room.tx((tx) => tx.changes.after(0, 1000));
    const mark = changes.at(-1)!.pos;
    const oldPos = changes.find((c) =>
      c.kind === 'event' && c.event === old.eventId
    )!.pos;
    let db = await store.server();
    await db.tx(async (tx) => {
      await tx.execute('INSERT INTO feed VALUES(41,?,?,?,1)', [
        g.roomId,
        oldPos,
        old.eventId,
      ]);
      await tx.execute(
        "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,?,?,'accepted','grounded',41)",
        [old.eventId, g.roomId, oldPos],
      );
      await tx.execute("INSERT INTO counters VALUES('events',41)");
      await tx.execute(
        'INSERT INTO relations(event,relates_to,rel_type,room,seq) VALUES(?,?,?,?,41)',
        [old.eventId, g.createId, 'm.reference', g.roomId],
      );
      await tx.execute('INSERT INTO watermarks VALUES(?,?)', [
        sourceOf(g.roomId),
        mark,
      ]);
      await tx.execute(
        "INSERT INTO receipts VALUES(?,'@bob:test','m.read.private','',?,123,1)",
        [g.roomId, old.eventId],
      );
    });
    await store.close();
    store = await openStore(settings, {
      schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
    });
    db = await store.server();
    for (const table of ['notifications', 'notification_receipt_refs']) {
      const plan = JSON.stringify(
        await db.query(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE event=? AND room=?`,
          ['$e', '!r:test'],
        ),
      );
      assert(plan.includes(table + '_event'), plan);
    }
    assertEquals((await db.query('SELECT event,seq FROM relations'))[0], {
      event: old.eventId,
      seq: 41,
    });
    await project(store, g.roomId);
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notifications'))[0].n,
      0,
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM push_evaluations'))[0].n,
      0,
    );
    assertEquals(await get(db, sourceOf(g.roomId)), mark);
    assertEquals((await db.query('SELECT seq FROM feed'))[0].seq, 41);
    const room = await openRoom(store, g.roomId);
    const fresh = await sendLocal(room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'new', msgtype: 'm.text' },
    }, g.signer);
    await project(store, g.roomId);
    const unread = () =>
      db.tx(async (tx) =>
        roomNotificationCounts(
          (await notificationSnapshot(tx, '@bob:test', 0)).rooms.get(g.roomId),
        )
      );
    assertEquals(await unread(), { notification_count: 1, highlight_count: 0 });
    assertEquals(
      (await db.query('SELECT event,event_seq FROM notifications'))[0],
      { event: fresh.eventId, event_seq: 42 },
    );
    assertEquals((await db.query('SELECT event_id,ts_ms FROM receipts'))[0], {
      event_id: old.eventId,
      ts_ms: 123,
    });
    // A failed transaction must roll back both the ledger's read flag and totals.
    await assertRejects(
      () =>
        db.tx(async (tx) => {
          await advanceNotificationRead(
            tx,
            '@bob:test',
            g.roomId,
            '',
            fresh.eventId,
            1234,
          );
          throw new Error('abort receipt transaction');
        }),
      Error,
      'abort receipt transaction',
    );
    assertEquals(await unread(), { notification_count: 1, highlight_count: 0 });
    const before = await db.query(
      'SELECT * FROM notification_horizons ORDER BY user,scope',
    );
    const cut = await get(db, sourceOf(g.roomId));
    // Force replay of committed source changes, as after an interrupted recovery.
    await db.execute('UPDATE watermarks SET position=? WHERE source=?', [
      mark,
      sourceOf(g.roomId),
    ]);
    await project(store, g.roomId);
    assertEquals(await get(db, sourceOf(g.roomId)), cut);
    assertEquals(
      await db.query('SELECT * FROM notification_horizons ORDER BY user,scope'),
      before,
    );
    assertEquals(await unread(), { notification_count: 1, highlight_count: 0 });
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notifications'))[0].n,
      1,
    );
    await store.close();
    store = await openStore(settings, {
      schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
    });
    db = await store.server();
    await project(store, g.roomId);
    assertEquals(await unread(), { notification_count: 1, highlight_count: 0 });
    const feed = await db.query('SELECT seq,event FROM feed ORDER BY seq');
    assertEquals(feed.map((r) => r.seq), [41, 42]);
    assert(feed.some((r) => r.event === fresh.eventId));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('push upgrade: durable chunks release projection lock, interleaved live counts stay exact and restart resumes', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    room: roomSchema,
    tenant: tenantSchema,
    server: serverSchema,
  };
  let store = await openStore(settings, { schemas });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const old = await genesis(store, { roomId: '!chunk-upgrade:test' });
    await bobJoins(old);
    for (let i = 0; i < 501; i++) {
      await sendLocal(old.room, {
        type: 'm.room.message',
        sender: old.creator,
        content: { body: 'old ' + i, msgtype: 'm.text' },
      }, old.signer);
    }
    await project(store, old.roomId);
    const other = await genesis(store, { roomId: '!chunk-live:test' });
    await bobJoins(other);
    await project(store, other.roomId);
    const fresh = await sendLocal(other.room, {
      type: 'm.room.message',
      sender: other.creator,
      content: { body: 'interleaved', msgtype: 'm.text' },
    }, other.signer);
    let db = await store.server();
    const cut = await get(db, sourceOf(old.roomId));
    const page = await db.query(
      `SELECT pos FROM event_index WHERE room=? AND standing='accepted'
      AND grounding='grounded' ORDER BY pos LIMIT 500`,
      [old.roomId],
    );
    const firstCut = Number(page.at(-1)!.pos);
    assert(firstCut < cut);
    const feed = await db.query(
      'SELECT * FROM feed WHERE room=? ORDER BY seq',
      [old.roomId],
    );
    await db.tx(async (tx) => {
      await tx.execute('DELETE FROM watermarks WHERE source=?', [
        'push-context:' + old.roomId,
      ]);
      await tx.execute('DELETE FROM notification_own_events WHERE room=?', [
        old.roomId,
      ]);
    });
    const originalQuery = db.query.bind(db);
    const originalServer = store.server.bind(store);
    store.server = () => Promise.resolve(db);
    let visited = 0;
    db.query = (...args: Parameters<typeof db.query>) => {
      if (args[0].includes('SELECT event,pos,seq FROM event_index')) {
        visited++;
        if (visited === 2) throw new Error('interrupt next upgrade chunk');
      }
      return originalQuery(...args);
    };
    try {
      const recovery = assertRejects(
        () => project(store, old.roomId),
        Error,
        'interrupt next upgrade chunk',
      );
      const live = project(store, other.roomId);
      const between = withProjectionLock(async () => {
        assertEquals(
          visited,
          1,
          'another projection gets the lock before the second upgrade page',
        );
        assertEquals(
          await get(db, 'push-context:' + old.roomId),
          firstCut,
          'queued live projection runs after exactly one durable upgrade chunk',
        );
        assertEquals(
          (await db.query('SELECT event FROM feed WHERE event=?', [
            fresh.eventId,
          ]))[0].event,
          fresh.eventId,
        );
        const snapshot = await db.tx((tx) =>
          notificationSnapshot(tx, '@bob:test', 0)
        );
        assertEquals(roomNotificationCounts(snapshot.rooms.get(other.roomId)), {
          notification_count: 1,
          highlight_count: 0,
        });
        assertEquals(roomNotificationCounts(snapshot.rooms.get(old.roomId)), {
          notification_count: 501,
          highlight_count: 0,
        });
      });
      const results = await Promise.allSettled([recovery, live, between]);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    } finally {
      db.query = originalQuery;
      store.server = originalServer;
    }
    assertEquals(await get(db, 'push-context:' + old.roomId), firstCut);
    await store.close();
    store = await openStore(settings, { schemas });
    db = await store.server();
    await project(store, old.roomId);
    assertEquals(await get(db, 'push-context:' + old.roomId), cut);
    assertEquals(
      await db.query('SELECT * FROM feed WHERE room=? ORDER BY seq', [
        old.roomId,
      ]),
      feed,
    );
    assertEquals(
      (await db.query(
        'SELECT COUNT(*) AS n FROM notification_own_events WHERE room=?',
        [old.roomId],
      ))[0].n,
      508,
    );
    assertEquals(
      (await db.query(
        'SELECT COUNT(*) AS n FROM notifications WHERE room=? AND read_ms IS NULL AND withdrawn=0',
        [old.roomId],
      ))[0].n,
      501,
    );
    // Two callers for this same room cooperate on its seed. Neither can move
    // the normal watermark past missing context before publishing a new event.
    await db.execute('DELETE FROM watermarks WHERE source=?', [
      'push-context:' + old.roomId,
    ]);
    const room = await openRoom(store, old.roomId);
    const ownRoomLive = await sendLocal(room, {
      type: 'm.room.message',
      sender: old.creator,
      content: { body: 'same-room live', msgtype: 'm.text' },
    }, old.signer);
    const seeding = project(store, old.roomId);
    const sameRoomBoundary = withProjectionLock(async () => {
      assertEquals(await get(db, 'push-context:' + old.roomId), firstCut);
      assertEquals(
        (await db.query('SELECT COUNT(*) AS n FROM feed WHERE event=?', [
          ownRoomLive.eventId,
        ]))[0].n,
        0,
        'same-room live publication waits for its complete context',
      );
    });
    const sameRoomLive = project(store, old.roomId);
    await Promise.all([seeding, sameRoomBoundary, sameRoomLive]);
    assertEquals(
      await get(db, 'push-context:' + old.roomId),
      await get(db, sourceOf(old.roomId)),
    );
    assertEquals(
      (await db.query(
        'SELECT COUNT(*) AS n FROM notification_own_events WHERE room=?',
        [old.roomId],
      ))[0].n,
      509,
    );
    assertEquals(
      (await db.query(
        'SELECT COUNT(*) AS n FROM notifications WHERE room=? AND read_ms IS NULL AND withdrawn=0',
        [old.roomId],
      ))[0].n,
      502,
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notifications WHERE event=?', [
        ownRoomLive.eventId,
      ]))[0].n,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
