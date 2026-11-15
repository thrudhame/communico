import { assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project } from '#engine/server/project.ts';
import {
  importReceiptOperation,
  receiptRows,
  setReceipt,
} from '#engine/server/ephemeral.ts';
import {
  receiptOperations,
  recordReceiptOperation,
} from '#engine/server/receipt-operations.ts';
import {
  advanceNotificationRead,
  notificationSnapshot,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { historicalServerSchema } from '#tests/fixtures/server-schema-history.ts';
import { advance, get } from '#engine/store/watermark.ts';

async function activateReceiptSource(f: Awaited<ReturnType<typeof fixture>>) {
  await f.db.execute(
    "INSERT INTO publication_domain VALUES(1,'home','publication','domain')",
  );
  await f.db.execute(
    'INSERT INTO facade_owner_controls VALUES(?,?,?,?)',
    [
      'receipt-test',
      1,
      'verified-test',
      JSON.stringify({
        body: {
          server: 'test',
          nodes: [
            { node: 'home', incarnation: 'home-store' },
            { node: 'edge', incarnation: 'edge-store' },
          ],
        },
      }),
    ],
  );
}

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
    base,
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

Deno.test('facade receipts: local authenticated admission and immutable source intent commit together', async () => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    await f.read(f.left, 'm.read.private', 'main');
    const rows = await f.db.query(
      "SELECT * FROM domain_operations WHERE kind='receipt'",
    );
    assertEquals(
      rows.length,
      1,
      'a successful receipt must retain semantic export intent',
    );
    const row = rows[0], payload = JSON.parse(String(row.payload_json));
    assertEquals(row.source, 'home');
    assertEquals(row.incarnation, 'home-store');
    assertEquals(payload.eventIds, [f.left]);
    assertEquals(payload.receiptType, 'm.read.private');
    assertEquals(payload.threadId, 'main');
    assertEquals(payload.userId, '@bob:test');
    assertEquals(typeof payload.admission.membershipEvent, 'string');
    assertEquals(payload.admission.membershipEvent.startsWith('$'), true);
    await f.read(f.left, 'm.read.private', 'main');
    assertEquals(
      (await f.db.query("SELECT * FROM domain_operations WHERE kind='receipt'"))
        .length,
      1,
    );
    await assertRejects(() =>
      f.db.tx(async (tx) => {
        await recordReceiptOperation(tx, { ...payload, eventIds: [f.right] });
        await tx.execute(
          "UPDATE memberships SET membership='leave' WHERE user='@bob:test'",
        );
        throw new Error('rollback admission cut');
      })
    );
    assertEquals(
      (await f.db.tx((tx) => receiptOperations(tx, '@bob:test'))).length,
      1,
    );
    assertEquals(
      (await f.db.query(
        "SELECT membership FROM memberships WHERE user='@bob:test'",
      ))[0].membership,
      'join',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: concurrent imported same-slot marks converge in both orders and duplicate without a register winner', async () => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    await f.read(f.left);
    const [home] = await f.db.tx((tx) => receiptOperations(tx, '@bob:test'));
    await f.db.execute('DELETE FROM domain_operations');
    await f.db.execute('DELETE FROM receipts');
    await f.db.execute("UPDATE publication_domain SET node='edge'");
    await f.read(f.right);
    const [edge] = await f.db.tx((tx) => receiptOperations(tx, '@bob:test'));
    assertEquals(home.context, []);
    assertEquals(edge.context, []);
    for (const order of [[home, edge], [edge, home]]) {
      await f.db.execute('DELETE FROM domain_operations');
      await f.db.execute('DELETE FROM receipts');
      for (const operation of [...order, ...order]) {
        await importReceiptOperation(f.db, operation, {
          source: operation.source,
          incarnation: operation.incarnation,
          userId: '@bob:test',
        });
      }
      assertEquals(
        (await receiptRows(f.db, f.g.roomId))[0].eventIds,
        [f.left, f.right].sort(),
      );
      assertEquals(
        (await f.db.query(
          "SELECT * FROM domain_operations WHERE kind='receipt'",
        )).length,
        2,
      );
      assertEquals(await f.db.query('SELECT * FROM domain_frontiers'), []);
      assertEquals(await f.db.query('SELECT * FROM domain_conflicts'), []);
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: a foreign server-name suffix never grants local account authorship', async () => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    await f.db.execute(
      "UPDATE memberships SET user='@bob:foreign:test' WHERE user='@bob:test'",
    );
    await setReceipt(f.db, f.g.roomId, '@bob:foreign:test', 'm.read', f.left);
    assertEquals(
      (await receiptRows(f.db, f.g.roomId))[0].userId,
      '@bob:foreign:test',
    );
    assertEquals(
      await f.db.query("SELECT * FROM domain_operations WHERE kind='receipt'"),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: a dominated incoming target still records its valid thread read and source intent without stream news', async () => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    const reply = (await sendLocal(f.g.room, {
      type: 'm.room.message',
      sender: f.g.creator,
      content: {
        body: 'thread notification',
        'm.relates_to': { rel_type: 'm.thread', event_id: f.left },
      },
    }, f.g.signer)).eventId;
    const outside = (await f.message('outside that thread', [reply])).eventId;
    await project(f.store, f.g.roomId);
    await f.read(outside, 'm.read.private', f.left);
    const before = await f.db.query(
      "SELECT value FROM counters WHERE name='receipts'",
    );
    assertEquals(
      (await f.db.query(
        'SELECT read_ms FROM notifications WHERE user=? AND event=?',
        ['@bob:test', reply],
      ))[0].read_ms,
      null,
    );
    await f.read(reply, 'm.read.private', f.left);
    assertEquals(
      (await f.db.query(
        'SELECT read_ms FROM notifications WHERE user=? AND event=?',
        ['@bob:test', reply],
      ))[0].read_ms !== null,
      true,
    );
    assertEquals(
      await f.db.query("SELECT value FROM counters WHERE name='receipts'"),
      before,
    );
    assertEquals(
      (await f.db.tx((tx) => receiptOperations(tx, '@bob:test'))).length,
      2,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: one ancestry closure serves every unread notification in a user-room-thread sweep', async () => {
  const f = await fixture();
  try {
    let walks = 0;
    await f.db.tx(async (tx) => {
      const counted = new Proxy(tx, {
        get(target, property) {
          if (property === 'query') {
            return (...args: Parameters<typeof tx.query>) => {
              if (args[0].includes('WITH RECURSIVE')) walks++;
              return target.query(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await advanceNotificationRead(
        counted,
        '@bob:test',
        f.g.roomId,
        '',
        f.base,
        Date.now(),
      );
    });
    assertEquals(
      walks,
      1,
      'unread notification count must not multiply ancestry traversals',
    );
    assertEquals(
      (await f.db.query(
        'SELECT event FROM notifications WHERE user=? AND read_ms IS NULL',
        ['@bob:test'],
      )).length,
      2,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: source admission names an authentic join for the same user, never another accepted event', async (t) => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    await f.read(f.left, 'm.read.private');
    const [operation] = await f.db.tx((tx) =>
      receiptOperations(tx, '@bob:test')
    );
    const [creatorJoin] = await f.db.query(
      'SELECT event FROM memberships WHERE user=? AND room=?',
      [f.g.creator, f.g.roomId],
    );
    const leave = await sendLocal(f.g.room, {
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'leave' },
    }, f.g.signer);
    await project(f.store, f.g.roomId);
    for (
      const [name, event] of [['message', f.left], [
        'other user join',
        String(creatorJoin.event),
      ], ['own leave', leave.eventId]]
    ) {
      await t.step(name, async () => {
        await f.db.execute('DELETE FROM domain_operations');
        await f.db.execute('DELETE FROM receipts');
        const mark = JSON.parse(operation.payload);
        mark.admission.membershipEvent = event;
        const payload = canonicalJson(mark);
        await importReceiptOperation(f.db, {
          ...operation,
          payload,
          payloadHash: createHash('sha256').update(payload).digest('hex'),
        }, { source: 'home', incarnation: 'home-store', userId: '@bob:test' });
        assertEquals(await receiptRows(f.db, f.g.roomId, 0, '@bob:test'), []);
      });
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: authenticated import retains original admission after departure without an export echo', async () => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    await f.read(f.left, 'm.read.private', 'main');
    await f.read(f.right);
    const operations = await f.db.tx((tx) =>
      receiptOperations(tx, '@bob:test')
    );
    assertEquals(operations.length, 2);
    await sendLocal(f.g.room, {
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'leave' },
    }, f.g.signer);
    await project(f.store, f.g.roomId);
    // Start the receiving replica at this already-projected departed-room cut.
    // It has the same accepted DAG, but no receipt intents or local positions.
    await f.db.execute('DELETE FROM domain_operations');
    await f.db.execute('DELETE FROM receipts');
    await f.db.execute("UPDATE publication_domain SET node='edge'");
    const authenticated = {
      source: 'home',
      incarnation: 'home-store',
      userId: '@bob:test',
    };
    for (const op of operations.toReversed()) {
      await importReceiptOperation(f.db, op, authenticated);
      await importReceiptOperation(f.db, op, authenticated);
    }
    const visible = await receiptRows(f.db, f.g.roomId, 0, '@bob:test');
    assertEquals(visible.length, 2);
    assertEquals(
      visible.find((row) => row.receiptType === 'm.read.private')?.eventIds,
      [f.left],
    );
    assertEquals((await receiptRows(f.db, f.g.roomId)).length, 1);
    assertEquals(
      (await f.db.tx((tx) => receiptOperations(tx, '@bob:test'))).length,
      2,
    );
    await assertRejects(
      () =>
        importReceiptOperation(f.db, operations[0], {
          ...authenticated,
          source: 'edge',
          incarnation: 'edge-store',
        }),
      Error,
      'receipt source unavailable',
    );
    await assertRejects(
      () =>
        importReceiptOperation(f.db, operations[0], {
          ...authenticated,
          userId: '@dev:test',
        }),
      Error,
      'receipt account not selected',
    );
    await assertRejects(
      () =>
        importReceiptOperation(f.db, {
          ...operations[0],
          payloadHash: '0'.repeat(64),
        }, authenticated),
      Error,
      'invalid receipt operation',
    );
    const before = await receiptRows(f.db, f.g.roomId, 0, '@bob:test');
    await f.store.close();
    const cold = await openStore(f.options, {
      schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    });
    try {
      await project(cold, f.g.roomId);
      assertEquals(
        await receiptRows(await cold.server(), f.g.roomId, 0, '@bob:test'),
        before,
      );
      assertEquals(
        (await (await cold.server()).tx((tx) =>
          receiptOperations(tx, '@bob:test')
        )).length,
        2,
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade receipts: missing receiver evidence stays pending and late projection resolves it after departure', async () => {
  const f = await fixture();
  try {
    await activateReceiptSource(f);
    const future =
      (await f.message('not yet disclosed', [f.left, f.right])).eventId;
    await f.read(future, 'm.read.private');
    const [op] = await f.db.tx((tx) => receiptOperations(tx, '@bob:test'));
    await f.db.execute('DELETE FROM domain_operations');
    await f.db.execute('DELETE FROM receipts');
    await f.db.execute('DELETE FROM notification_graph_reads');
    await f.db.execute("UPDATE publication_domain SET node='edge'");
    await importReceiptOperation(f.db, op, {
      source: 'home',
      incarnation: 'home-store',
      userId: '@bob:test',
    });
    assertEquals(await receiptRows(f.db, f.g.roomId, 0, '@bob:test'), []);
    assertEquals(
      (await f.db.query('SELECT applied FROM domain_operations'))[0].applied,
      0,
    );
    await sendLocal(f.g.room, {
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'leave' },
    }, f.g.signer);
    await project(f.store, f.g.roomId);
    assertEquals(
      (await receiptRows(f.db, f.g.roomId, 0, '@bob:test'))[0].eventIds,
      [future],
    );
    assertEquals(await receiptRows(f.db, f.g.roomId), []);
    assertEquals(
      (await f.db.query('SELECT applied FROM domain_operations'))[0].applied,
      1,
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

Deno.test('facade receipts: actual v38 upgrade re-seeds authentic membership evidence without new feed publication', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'receipt-admission-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { room: roomSchema, server: historicalServerSchema(38) },
  });
  try {
    const g = await genesis(store, {
      roomId: '!receipt-admission-upgrade:test',
    });
    const joined = await bobJoins(g);
    const changes = await g.room.tx((tx) => tx.changes.after(0, 500));
    const mark = changes.at(-1)!.pos, db = await store.server();
    await db.tx(async (tx) => {
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
        await tx.execute('INSERT INTO receipt_dag_nodes VALUES(?,?)', [
          g.roomId,
          change.event,
        ]);
      }
      await advance(tx, 'room:' + g.roomId, mark);
      await advance(tx, 'push-context:' + g.roomId, mark);
      await advance(tx, 'receipt-graph:' + g.roomId, mark);
    });
    await store.close();
    store = await openStore(options, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    const upgraded = await store.server();
    assertEquals(await get(upgraded, 'receipt-graph:' + g.roomId), 0);
    await project(store, g.roomId);
    assertEquals(
      await upgraded.query(
        'SELECT user,membership FROM receipt_membership_events WHERE room=? AND event=?',
        [g.roomId, joined],
      ),
      [{ user: '@bob:test', membership: 'join' }],
    );
    assertEquals(await upgraded.query('SELECT * FROM feed'), []);
    assertEquals(await get(upgraded, 'receipt-graph:' + g.roomId), mark);
    const facts = await upgraded.query(
      'SELECT * FROM receipt_membership_events ORDER BY event',
    );
    await project(store, g.roomId);
    assertEquals(
      await upgraded.query(
        'SELECT * FROM receipt_membership_events ORDER BY event',
      ),
      facts,
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
