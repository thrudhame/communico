import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { config } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { rebaseRestoredDeviceStreams } from '#engine/tenant/changes.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import {
  completeBatch,
  freezeBatch,
  frozenBatch,
  pendingEdus,
} from '#engine/server/delivery.ts';
import {
  cachedDeviceKeys,
  invalidateRestoredDeviceCaches,
} from '#engine/server/remote-devices.ts';
import { deviceSnapshot } from '#engine/tenant/e2ee.ts';

const alice = '@alice:restore.test', bob = '@bob:peer.test';
async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'restore-devices-' });
  const store = await openStore({
    dir: join(root, 'store'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema, server: serverSchema } });
  const tenant = await openTenant(store, 'restore.test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('empty', 'Empty');
    await tx.devices.upsert('PHONE', 'alice', 'Before');
  });
  await projectTenant(store, tenant.serverName);
  const db = await store.server();
  await db.tx((tx) =>
    reconcileDeviceRoom(tx, '!shared:test', [alice, bob], false, null, 1, [
      'restore.test',
    ])
  );
  const tenantDb = await store.tenant(tenant.serverName);
  return {
    store,
    tenant,
    tenantDb,
    db,
    close: async () => {
      await store.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test('restore device streams: a fresh reset follows exact retained frozen work and anchors subsequent updates', async () => {
  const f = await fixture();
  try {
    const initial = await pendingEdus(f.db, 'peer.test', 100);
    const batch = {
      txnId: 'retained-uuid',
      body: 'exact frozen envelope',
      rows: [],
      sources: initial.map((e) => e.source),
    };
    assert(await freezeBatch(f.db, 'peer.test', batch));
    await f.tenant.tx((tx) => tx.devices.upsert('PHONE', 'alice', 'After cut'));
    await projectTenant(f.store, 'restore.test');
    const before = await pendingEdus(f.db, 'peer.test', 100);
    const sources = await f.tenantDb.query(
      'SELECT * FROM e2ee_changes ORDER BY pos',
    );
    const rebased = await f.tenantDb.tx((tx) =>
      rebaseRestoredDeviceStreams(tx)
    );
    assertEquals(rebased.users, 2);
    assert(Number.isSafeInteger(rebased.floor));
    assert(rebased.floor > 2);
    await projectTenant(f.store, 'restore.test');
    assertEquals(await frozenBatch(f.db, 'peer.test'), batch);
    const after = await pendingEdus(f.db, 'peer.test', 100);
    assertEquals(after.slice(0, before.length), before);
    const reset = after.at(-1)!;
    assertEquals(reset.edu_type, 'm.device_list_update');
    assertEquals(reset.content, {
      user_id: alice,
      device_id: '',
      deleted: true,
      stream_id: rebased.floor,
      prev_id: [],
    });
    assertEquals(
      await f.tenantDb.query(
        'SELECT * FROM e2ee_changes WHERE pos<=? ORDER BY pos',
        [sources.at(-1)!.pos],
      ),
      sources,
    );
    const snapshot = await f.tenantDb.tx((tx) =>
      deviceSnapshot(tx, 'alice', alice, config().e2ee)
    );
    assertEquals(snapshot.stream_id, rebased.floor);
    await f.db.tx((tx) => completeBatch(tx, 'peer.test', batch));
    assertEquals(await frozenBatch(f.db, 'peer.test'), null);
    assertEquals((await pendingEdus(f.db, 'peer.test', 100)).at(-1), reset);
    await f.tenant.tx((tx) => tx.devices.upsert('PHONE', 'alice', 'Restored'));
    await projectTenant(f.store, 'restore.test');
    const next = (await pendingEdus(f.db, 'peer.test', 100)).at(-1)!;
    assertEquals(next.content.prev_id, [rebased.floor]);
    assertEquals(next.content.stream_id, rebased.floor + 1);
    await projectTenant(f.store, 'restore.test');
    assertEquals((await pendingEdus(f.db, 'peer.test', 100)).at(-1), next);
    // A later subscription must use the restore-era anchor even for empty users.
    await f.db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!new:test',
        ['@empty:restore.test', '@new:other.test'],
        false,
        null,
        1,
        ['restore.test'],
      )
    );
    const empty = (await pendingEdus(f.db, 'other.test', 100)).at(-1)!;
    assertEquals(empty.content.stream_id, rebased.floor);
    assertEquals(empty.content.prev_id, []);
  } finally {
    await f.close();
  }
});

Deno.test('restore device streams: rebasing rolls back with its immutable reset intents and advances beyond large archived heads', async () => {
  const f = await fixture();
  try {
    const before = await f.tenantDb.query('SELECT * FROM user_device_stream');
    await assertRejects(
      () =>
        f.tenantDb.tx(async (tx) => {
          await rebaseRestoredDeviceStreams(tx);
          throw new Error('candidate failed');
        }),
      Error,
      'candidate failed',
    );
    assertEquals(
      await f.tenantDb.query('SELECT * FROM user_device_stream'),
      before,
    );
    await f.tenantDb.execute('UPDATE user_device_stream SET value=?', [
      8_000_000_000_000_000,
    ]);
    const result = await f.tenantDb.tx(rebaseRestoredDeviceStreams);
    assert(result.floor > 8_000_000_000_000_000);
    const again = await f.tenantDb.tx(rebaseRestoredDeviceStreams);
    assert(again.floor > result.floor);
  } finally {
    await f.close();
  }
});

Deno.test('restore device streams: keyset rebasing includes every user, empty accounts and archived deleted-user allocators', async () => {
  const f = await fixture();
  try {
    await f.tenantDb.tx(async (tx) => {
      for (let n = 0; n < 257; n++) {
        await tx.execute('INSERT INTO user_device_stream VALUES(?,?)', [
          'retired-' + n,
          n + 1,
        ]);
      }
      const result = await rebaseRestoredDeviceStreams(tx);
      assertEquals(result.users, 259);
      assertEquals(
        await tx.query('SELECT DISTINCT value FROM user_device_stream'),
        [{ value: result.floor }],
      );
      assertEquals(
        (await tx.query(
          "SELECT pos FROM e2ee_changes WHERE json_extract(payload,'$.kind')='restore_reset'",
        )).length,
        259,
      );
    });
  } finally {
    await f.close();
  }
});

Deno.test('restore remote devices: stale cache and causal memory cannot answer queries, trust and pending delivery remain retained', async () => {
  const f = await fixture();
  try {
    await f.db.execute(
      "UPDATE remote_device_users SET stale=0,anchor='12',seen='[\"12\"]',pending='[]',failures=4,retry_at=999999 WHERE user_id=?",
      [bob],
    );
    await f.db.execute('INSERT INTO remote_device_keys VALUES(?,?,?)', [
      bob,
      'REMOTE',
      '{"keys":{}}',
    ]);
    const before = await f.db.query('SELECT * FROM edu_outbox');
    assert(await cachedDeviceKeys(f.db, bob, [], alice));
    assertEquals(await f.db.tx(invalidateRestoredDeviceCaches), 1);
    assertEquals(await cachedDeviceKeys(f.db, bob, [], alice), null);
    const [state] = await f.db.query(
      'SELECT * FROM remote_device_users WHERE user_id=?',
      [bob],
    );
    assertEquals(state.anchor, null);
    assertEquals(state.stale, 1);
    assertEquals(state.pending, '[]');
    assertEquals(state.seen, '[]');
    assertEquals(state.failures, 0);
    assertEquals(state.retry_at, 0);
    assertEquals(await f.db.query('SELECT * FROM edu_outbox'), before);
    assertEquals(
      (await f.db.query('SELECT * FROM remote_device_keys')).length,
      1,
    );
  } finally {
    await f.close();
  }
});
