import { assert, assertEquals } from '@std/assert';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { TENANT_V12 } from '#tests/fixtures/tenant-v12.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { project } from '#engine/server/project.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { finishRoomRemoval } from '#engine/server/removal.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';

const tables = [
  'push_evaluations',
  'notifications',
  'notification_counts',
  'notification_horizons',
  'notification_receipt_refs',
  'notification_changes',
  'notification_own_events',
  'notification_history',
];

async function setup(store: Store) {
  const tenant = await openTenant(store, 'test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('dev', 'Dev');
    await tx.users.insert('bob', 'Bob');
  });
  const rooms = [];
  for (const name of ['one', 'two']) {
    const g = await genesis(store, { roomId: `!push-lifecycle-${name}:test` });
    await bobJoins(g);
    await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'hello', msgtype: 'm.text' },
    }, g.signer);
    await project(store, g.roomId);
    const db = await store.server();
    await db.tx((tx) =>
      advanceNotificationRead(
        tx,
        '@bob:test',
        g.roomId,
        '',
        '$unknown-' + name,
        123,
      )
    );
    rooms.push(g);
  }
  return { tenant, rooms, db: await store.server() };
}

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('push lifecycle: room removal deletes all projection facts and its context watermark, preserving other rooms', async () => {
  await withStore(async (store) => {
    const { db, rooms: [gone, kept] } = await setup(store);
    for (const table of tables) {
      assert(
        (await db.query(`SELECT 1 FROM ${table} WHERE room=?`, [gone.roomId]))
          .length > 0,
        table,
      );
    }
    await finishRoomRemoval(store, gone.roomId, {
      why: 'test removal',
      intents: [],
    }, null);
    for (const table of tables) {
      assertEquals(
        await db.query(`SELECT 1 FROM ${table} WHERE room=?`, [gone.roomId]),
        [],
        table,
      );
      assert(
        (await db.query(`SELECT 1 FROM ${table} WHERE room=?`, [kept.roomId]))
          .length > 0,
        table,
      );
    }
    assertEquals(
      await db.query('SELECT 1 FROM watermarks WHERE source=?', [
        'push-context:' + gone.roomId,
      ]),
      [],
    );
    assertEquals(
      (await db.query(
        'SELECT unread FROM notification_counts WHERE user=? AND room=?',
        ['@bob:test', kept.roomId],
      ))[0].unread,
      1,
    );
  });
});

Deno.test('push lifecycle: deactivation rolls notification cleanup forward after a missed tenant projection without touching peers', async () => {
  await withStore(async (store) => {
    const { db, tenant, rooms } = await setup(store);
    // No installed tenant hook: simulate interruption after tenant commit.
    await deactivateUser(tenant, 'bob');
    assert(
      (await db.query('SELECT 1 FROM notifications WHERE user=?', [
        '@bob:test',
      ])).length > 0,
    );
    await projectTenant(store, 'test');
    for (const table of tables) {
      assertEquals(
        await db.query(`SELECT 1 FROM ${table} WHERE user=?`, ['@bob:test']),
        [],
        table,
      );
    }
    assert(
      (await db.query('SELECT 1 FROM notification_own_events WHERE user=?', [
        '@dev:test',
      ])).length > 0,
    );
    for (const g of rooms) {
      await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'after deactivation', msgtype: 'm.text' },
      }, g.signer);
      await project(store, g.roomId);
    }
    await projectTenant(store, 'test');
    assertEquals(
      await db.query('SELECT 1 FROM notifications WHERE user=?', ['@bob:test']),
      [],
    );
  });
});

Deno.test('push reconciliation uses event-leading indexes in fresh stores', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    for (const table of ['notifications', 'notification_receipt_refs']) {
      const plan = JSON.stringify(
        await db.query(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE event=? AND room=?`,
          ['$e', '!r:test'],
        ),
      );
      assert(plan.includes(table + '_event'), plan);
    }
  });
});

Deno.test('push lifecycle: v12 account upgrade seeds deactivated cleanup once and keeps tenant identity', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: {
      tenant: { version: 12, apply: (db) => db.exec(TENANT_V12) },
      server: serverSchema,
    },
  });
  try {
    let tenant = await openTenant(store, 'test', { create: true });
    const key = tenant.publicB64;
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const old = await store.tenant('test');
    await old.execute("UPDATE users SET deactivated=1 WHERE localpart='bob'");
    const db = await store.server();
    await db.execute(
      "INSERT INTO notification_counts VALUES('@bob:test','!gone:test','main',1,0)",
    );
    await store.close();
    store = await openStore(options, {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    tenant = await openTenant(store, 'test');
    assertEquals(tenant.publicB64, key);
    await projectTenant(store, 'test');
    assertEquals(
      await (await store.server()).query('SELECT * FROM notification_counts'),
      [],
    );
    const account = await store.tenant('test');
    const changes = await account.query('SELECT * FROM account_changes');
    assertEquals(changes.length, 1);
    await deactivateUser(tenant, 'bob');
    await projectTenant(store, 'test');
    assertEquals(await account.query('SELECT * FROM account_changes'), changes);
    await tenant.tx((tx) => tx.users.insert('dev', 'Dev'));
    await deactivateUser(tenant, 'dev');
    const later = await account.query(
      'SELECT pos FROM account_changes ORDER BY pos',
    );
    assert(Number(later[1].pos) > Number(later[0].pos));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
