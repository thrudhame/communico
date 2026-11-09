import { assert, assertEquals, assertRejects } from '@std/assert';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { openStore } from '#engine/store/index.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { project, sourceOf } from '#engine/server/project.ts';
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
