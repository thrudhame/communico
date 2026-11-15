import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project } from '#engine/server/project.ts';
import { receiptRows, setReceipt } from '#engine/server/ephemeral.ts';
import {
  notificationSnapshot,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { historicalServerSchema } from '#tests/fixtures/server-schema-history.ts';
import { advance, get } from '#engine/store/watermark.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-receipts-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const store = await openStore(options, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  const tenant = await openTenant(store, 'test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('dev', 'Dev');
    await tx.users.insert('bob', 'Bob');
  });
  const g = await genesis(store, { roomId: '!receipt-frontier:test' });
  const base = await bobJoins(g);
  const message = (body: string, prevs = [base]) =>
    sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body },
      prev_events: prevs,
    }, g.signer);
  const left = (await message('left')).eventId;
  const right = (await message('right')).eventId;
  await project(store, g.roomId);
  const db = await store.server();
  // The signed-control activation itself is covered by facade-ownership. These
  // owner tests start at its committed per-file activation boundary.
  await db.execute(
    "INSERT INTO facade_owner_activation VALUES('receipt-test',1,'verified-test')",
  );
  return {
    store,
    options,
    dir,
    g,
    db,
    left,
    right,
    message,
    read: (
      event: string,
      type: 'm.read' | 'm.read.private' = 'm.read',
      threadId?: string,
    ) => setReceipt(db, g.roomId, '@bob:test', type, event, { threadId }),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade receipts: concurrent graph marks union and only proved ancestors retire', async () => {
  const f = await fixture();
  try {
    await f.read(f.left);
    await f.read(f.right);
    assertEquals(
      (await receiptRows(f.db, f.g.roomId))[0].eventIds.toSorted(),
      [f.left, f.right].sort(),
    );
    const before = await f.db.query(
      "SELECT value FROM counters WHERE name='receipts'",
    );
    await f.read(f.left);
    assertEquals(
      await f.db.query("SELECT value FROM counters WHERE name='receipts'"),
      before,
      'duplicate graph mark is not new arrival news',
    );
    const joined =
      (await f.message('join branches', [f.left, f.right])).eventId;
    await project(f.store, f.g.roomId);
    await f.read(joined);
    assertEquals((await receiptRows(f.db, f.g.roomId))[0].eventIds, [joined]);
    await f.read(f.left);
    assertEquals((await receiptRows(f.db, f.g.roomId))[0].eventIds, [joined]);
    await f.read('$unknown-left');
    await f.read('$unknown-right');
    assertEquals(
      (await receiptRows(f.db, f.g.roomId))[0].eventIds.toSorted(),
      ['$unknown-left', '$unknown-right', joined].sort(),
    );
    await f.read(f.left, 'm.read.private');
    await f.read(f.right, 'm.read.private', 'main');
    assertEquals(
      (await receiptRows(f.db, f.g.roomId)).length,
      1,
      'private marks never escape the owner',
    );
    assertEquals(
      (await receiptRows(f.db, f.g.roomId, 0, '@bob:test')).length,
      3,
      'type and thread frontiers stay separate',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: a later local arrival is not proof its concurrent sibling was read', async () => {
  const f = await fixture();
  try {
    const count = () =>
      f.db.tx(async (tx) =>
        roomNotificationCounts(
          (await notificationSnapshot(tx, '@bob:test', 0)).rooms.get(
            f.g.roomId,
          ),
        ).notification_count
      );
    assertEquals(await count(), 2);
    await f.read(f.right);
    assertEquals(
      await count(),
      1,
      'reading the higher local seq must not clear the unread concurrent left branch',
    );
    await f.read(f.left, 'm.read.private');
    assertEquals(await count(), 0);
    const late = (await f.message('late arrival on right', [f.right])).eventId;
    await project(f.store, f.g.roomId);
    assertEquals(
      await count(),
      1,
      'an ancestor receipt never reads its new descendant',
    );
    await f.read(late);
    assertEquals(await count(), 0);
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: every arrival permutation and cold reopen preserves public/private/thread graph cuts', async () => {
  for (const reverse of [false, true]) {
    const f = await fixture();
    try {
      for (const target of reverse ? [f.right, f.left] : [f.left, f.right]) {
        await f.read(target);
        await f.read(target);
      }
      const thread = (await sendLocal(f.g.room, {
        type: 'm.room.message',
        sender: f.g.creator,
        content: {
          body: 'thread reply',
          'm.relates_to': { rel_type: 'm.thread', event_id: f.left },
        },
        prev_events: [f.right],
      }, f.g.signer)).eventId;
      await project(f.store, f.g.roomId);
      await f.read(thread, 'm.read.private', f.left);
      await f.read(f.right, 'm.read.private', 'main');
      const expected = await receiptRows(f.db, f.g.roomId, 0, '@bob:test');
      const publicRows = await receiptRows(
        f.db,
        f.g.roomId,
        0,
        '@observer:test',
      );
      assertEquals(publicRows.length, 1);
      assertEquals(publicRows[0].eventIds, [f.left, f.right].sort());
      const before = await f.db.query(
        'SELECT * FROM notification_counts ORDER BY user,room,thread',
      );
      await f.store.close();
      const cold = await openStore(f.options, {
        schemas: {
          room: roomSchema,
          tenant: tenantSchema,
          server: serverSchema,
        },
      });
      try {
        await project(cold, f.g.roomId);
        const db = await cold.server();
        assertEquals(
          await receiptRows(db, f.g.roomId, 0, '@bob:test'),
          expected,
        );
        assertEquals(
          await receiptRows(db, f.g.roomId, 0, '@observer:test'),
          publicRows,
        );
        assertEquals(
          await db.query(
            'SELECT * FROM notification_counts ORDER BY user,room,thread',
          ),
          before,
        );
      } finally {
        await cold.close();
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test('facade receipts: late accepted ancestry applies an already admitted mark after its user departs', async () => {
  const f = await fixture();
  try {
    const future =
      (await f.message('not projected yet', [f.left, f.right])).eventId;
    await f.read(f.left);
    await f.read(future);
    assertEquals(
      (await receiptRows(f.db, f.g.roomId))[0].eventIds,
      [f.left, future].sort(),
      'missing ancestry stays retained',
    );
    await sendLocal(f.g.room, {
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'leave' },
    }, f.g.signer);
    await project(f.store, f.g.roomId);
    assertEquals(
      (await receiptRows(f.db, f.g.roomId))[0].eventIds,
      [future],
      'late ancestry reduces the mark despite later departure',
    );
    assertEquals(
      await f.db.query(
        'SELECT event FROM notification_receipt_refs WHERE user=? AND room=?',
        ['@bob:test', f.g.roomId],
      ),
      [],
    );
    assertEquals(
      (await f.db.query(
        'SELECT read_ms FROM notifications WHERE user=? AND event=?',
        ['@bob:test', future],
      ))[0].read_ms !== null,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: v37 horizons retain exact graph target identity on upgrade, never an inferred foreign position', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'receipt-horizon-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { server: historicalServerSchema(37) },
  });
  try {
    const old = await store.server();
    await old.execute(
      "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$read','!room:test',1,'accepted','grounded',7)",
    );
    await old.execute(
      "INSERT INTO notification_horizons VALUES('@bob:test','!room:test','main',7)",
    );
    await old.execute(
      "INSERT INTO notification_horizons VALUES('@other:test','!other:test','',7)",
    );
    await store.close();
    store = await openStore(options, { schemas: { server: serverSchema } });
    assertEquals(
      await (await store.server()).query(
        'SELECT * FROM notification_graph_reads',
      ),
      [{
        user: '@bob:test',
        room: '!room:test',
        scope: 'main',
        event: '$read',
      }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('facade receipts: actual v37 upgrade seeds already projected graph without publishing historical events as news', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'receipt-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { room: roomSchema, server: historicalServerSchema(37) },
  });
  try {
    const g = await genesis(store, { roomId: '!receipt-upgrade:test' });
    const joined = await bobJoins(g);
    const left = (await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'left' },
      prev_events: [joined],
    }, g.signer)).eventId;
    const right = (await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'right' },
      prev_events: [joined],
    }, g.signer)).eventId;
    const end = (await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'end' },
      prev_events: [left, right],
    }, g.signer)).eventId;
    const changes = await g.room.tx((tx) => tx.changes.after(0, 500));
    const mark = changes.at(-1)!.pos;
    const old = await store.server();
    await old.tx(async (tx) => {
      for (const change of changes) {
        if (change.kind !== 'event' || change.event === null) continue;
        const payload = JSON.parse(change.data);
        await tx.execute(
          'INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,?,?,?,?,NULL)',
          [
            change.event,
            g.roomId,
            change.pos,
            payload.standing,
            payload.grounding,
          ],
        );
      }
      await tx.execute("INSERT INTO receipts VALUES(?,?,'m.read','',?,1,7)", [
        g.roomId,
        '@bob:test',
        JSON.stringify([left, right, end]),
      ]);
      await tx.execute("INSERT INTO counters VALUES('receipts',7)");
      await tx.execute(
        "INSERT INTO facade_owner_activation VALUES('receipt-test',1,'verified-test')",
      );
      await advance(tx, 'room:' + g.roomId, mark);
      await advance(tx, 'push-context:' + g.roomId, mark);
    });
    await store.close();
    store = await openStore(options, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    const db = await store.server();
    assertEquals(await db.query('SELECT * FROM receipt_dag_nodes'), []);
    await project(store, g.roomId);
    const rows = await receiptRows(db, g.roomId);
    assertEquals(rows[0].eventIds, [end]);
    assertEquals(
      rows[0].seq,
      8,
      'new local receipt publication, never a copied position',
    );
    assertEquals(await db.query('SELECT * FROM feed'), []);
    assertEquals(await get(db, 'receipt-graph:' + g.roomId), mark);
    await project(store, g.roomId);
    assertEquals(
      (await receiptRows(db, g.roomId))[0].seq,
      8,
      'seed replay is idempotent',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
