import { assertEquals, assertRejects } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { eduQueues, eduState } from '#engine/federation/edus.ts';
import {
  receiptRows,
  receiptsSince,
  setReceiptMark,
  streamMax,
} from '#engine/server/ephemeral.ts';
import { receiptsExtension } from '#engine/sliding-sync/extensions.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { reconcileNotificationEvent } from '#engine/server/notifications.ts';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';

Deno.test('receipt mark: inbound extremities survive storage, ordinary/sliding rendering and replacement', async () => {
  const http = await startHttp();
  try {
    const user = await http.registerTestUser('extremities', 'pw');
    const response = await http.matrix(
      new Request('http://x/_matrix/client/v3/createRoom', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token },
        body: '{}',
      }),
    );
    const { room_id: room } = await response.json();
    assertEquals(response.status, 200);
    const db = http.app.server;
    const inbound = eduState(db, 'localhost', http.app.store);
    const dispatch = (ids: unknown[], ts = 1) =>
      inbound.dispatch('localhost', {
        edu_type: 'm.receipt',
        content: {
          [room]: {
            'm.read': { [user.user_id!]: { event_ids: ids, data: { ts } } },
          },
        },
      });
    const before = await streamMax(db, 'receipts');
    await dispatch(['$left', '$right']);
    assertEquals(
      await streamMax(db, 'receipts'),
      before + 1,
      'one stream position per whole mark',
    );
    const read = async () => {
      const rows = await receiptRows(db, room);
      const ordinary = await receiptsSince(db, room, user.user_id!, 0);
      assertEquals(Object.keys(ordinary[0]).sort(), ['$left', '$right']);
      const sliding = receiptsExtension(
        '@observer:localhost',
        new Set([room]),
        new Map([[room, rows]]),
        before + 1,
        {},
        {
          [room]: { initial: true, timeline: [{ event_id: '$right' }] },
        },
      );
      assertEquals(Object.keys(sliding.response.rooms[room].content).sort(), [
        '$left',
        '$right',
      ]);
      assertEquals(
        (await db.query(
          'SELECT event FROM notification_receipt_refs WHERE room=? ORDER BY event',
          [room],
        )).map((r) => r.event),
        ['$left', '$right'],
      );
    };
    await read();
    // A malformed extremity refuses the entire mark, rather than retaining its
    // valid prefix or preventing subsequent independent entries from working.
    await dispatch(['$partial', 5], 2);
    assertEquals(await streamMax(db, 'receipts'), before + 1);
    await read();
    await dispatch(['$new-left', '$new-right'], 3);
    assertEquals(await streamMax(db, 'receipts'), before + 2);
    const ordinary = await receiptsSince(db, room, user.user_id!, before + 1);
    assertEquals(Object.keys(ordinary[0]).sort(), ['$new-left', '$new-right']);
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM receipts WHERE room_id=?', [
        room,
      ]))[0].n,
      1,
    );
  } finally {
    await http.close();
  }
});

Deno.test('receipt mark: reopen retains every target, late projections reconcile all extremities and capacity refusal rolls back the whole mark', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const room = '!mark:test', user = '@reader:test';
  let store = await openStore(settings, { schemas: { server: serverSchema } });
  try {
    let db = await store.server();
    await db.execute("INSERT INTO memberships VALUES(?,?,'join','$join',0)", [
      user,
      room,
    ]);
    await setReceiptMark(db, room, user, 'm.read', ['$left', '$right'], {
      ts: 123,
    });
    await store.close();
    store = await openStore(settings, { schemas: { server: serverSchema } });
    db = await store.server();
    assertEquals(await receiptRows(db, room), [{
      userId: user,
      receiptType: 'm.read',
      threadId: null,
      eventIds: ['$left', '$right'],
      ts: 123,
      seq: 1,
    }]);
    for (const [event, seq] of [['$left', 7], ['$right', 9]] as const) {
      await db.tx(async (tx) => {
        await tx.execute(
          "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,?,?,'accepted','grounded',?)",
          [event, room, seq, seq],
        );
        await reconcileNotificationEvent(tx, room, event, 456);
      });
    }
    assertEquals(
      await db.query(
        'SELECT event_seq FROM notification_horizons WHERE user=? AND room=?',
        [user, room],
      ),
      [{ event_seq: 9 }],
    );
    assertEquals(await db.query('SELECT * FROM notification_receipt_refs'), []);
    await db.execute(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<255)
      INSERT INTO notification_receipt_refs(user,room,scope,event) SELECT ?,?,'','$pending-' || i FROM n`,
      [user, room],
    );
    const before = await receiptRows(db, room);
    await assertRejects(() =>
      setReceiptMark(
        db,
        room,
        user,
        'm.read',
        ['$left', '$fits', '$overflow'],
        { ts: 999 },
      )
    );
    assertEquals(await streamMax(db, 'receipts'), 1);
    assertEquals(await receiptRows(db, room), before);
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notification_receipt_refs'))[0]
        .n,
      255,
    );
    assertEquals(
      await db.query(
        "SELECT event FROM notification_receipt_refs WHERE event IN ('$fits','$overflow')",
      ),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('receipt mark: outbound queue snapshots and coalesces whole extremity sets', () => {
  const queues = eduQueues(() => true);
  const targets = ['$left', '$right'];
  const mark = {
    roomId: '!r:test',
    userId: '@u:test',
    threadId: null,
    ts: 1,
    eventIds: targets,
  };
  queues.queueReceipt('peer', mark, 2);
  targets.splice(0, targets.length, '$mutated');
  queues.queueReceipt('peer', { ...mark, eventIds: ['$stale'] }, 1);
  assertEquals(queues.drain('peer', 1), [{
    edu_type: 'm.receipt',
    content: {
      '!r:test': {
        'm.read': {
          '@u:test': { event_ids: ['$left', '$right'], data: { ts: 1 } },
        },
      },
    },
  }]);
  queues.queueReceipt('peer', {
    ...mark,
    eventIds: ['$next-left', '$next-right'],
  }, 3);
  assertEquals(queues.drain('peer', 1), [{
    edu_type: 'm.receipt',
    content: {
      '!r:test': {
        'm.read': {
          '@u:test': {
            event_ids: ['$next-left', '$next-right'],
            data: { ts: 1 },
          },
        },
      },
    },
  }]);
});

Deno.test('receipt mark: v23 upgrade preserves singleton targets, types, threads, timestamps and stream cuts', async () => {
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
      server: {
        version: 23,
        apply: async (db) => {
          await db.exec(SERVER_V13);
          await db.tx(async (tx) => {
            for (let version = 13; version < 23; version++) {
              await serverSchema.migrations![version](tx);
            }
          }, { mode: 'deferred' });
        },
      },
    },
  });
  try {
    const old = await store.server();
    await old.execute(
      `INSERT INTO receipts VALUES('!r:test','@u:test','m.read','','$public',100,7)`,
    );
    await old.execute(
      `INSERT INTO receipts VALUES('!r:test','@u:test','m.read.private','$thread','$private',200,8)`,
    );
    await old.execute("INSERT INTO counters VALUES('receipts',8)");
    await store.close();
    store = await openStore(settings, { schemas: { server: serverSchema } });
    const db = await store.server();
    assertEquals(await streamMax(db, 'receipts'), 8);
    assertEquals(await receiptRows(db, '!r:test', 0, '@u:test'), [
      {
        userId: '@u:test',
        receiptType: 'm.read',
        threadId: null,
        eventIds: ['$public'],
        ts: 100,
        seq: 7,
      },
      {
        userId: '@u:test',
        receiptType: 'm.read.private',
        threadId: '$thread',
        eventIds: ['$private'],
        ts: 200,
        seq: 8,
      },
    ]);
    assertEquals((await receiptRows(db, '!r:test')).length, 1);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
