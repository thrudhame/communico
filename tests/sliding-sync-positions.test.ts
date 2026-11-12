import { assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';

const configuration = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('sliding positions: issued snapshots isolate owner, generation and connection; retry, fork and reopen', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(configuration(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    let tenant = await openTenant(store, 'sliding.test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('a', 'A');
      await tx.users.insert('b', 'B');
      await tx.devices.upsert('PHONE', 'a', null);
      await tx.devices.upsert('OTHER', 'a', null);
      await tx.devices.upsert('PHONE', 'b', null);
    });
    const a = await deviceIdentity(tenant, 'a', 'PHONE');
    const other = await deviceIdentity(tenant, 'a', 'OTHER');
    const b = await deviceIdentity(tenant, 'b', 'PHONE');
    const begin = () =>
      tenant.tx((tx) => tx.slidingSync.begin(a, 'room-list', null));
    const initial = await begin();
    const p1 = await tenant.tx((tx) =>
      tx.slidingSync.commit(a, initial, { cut: 10, rooms: {} })
    );
    for (
      const [device, name, position] of [
        [b, 'room-list', p1],
        [other, 'room-list', p1],
        [a, 'encryption', p1],
        [a, 'room-list', 'forged'],
      ] as const
    ) {
      const error = await assertRejects(
        () => tenant.tx((tx) => tx.slidingSync.begin(device, name, position)),
        MatrixError,
      );
      assertEquals(error.errcode, 'M_UNKNOWN_POS');
    }
    const retry = await tenant.tx((tx) =>
      tx.slidingSync.begin(a, 'room-list', p1)
    );
    assertEquals(retry.state, { cut: 10, rooms: {} });
    const p2 = await tenant.tx((tx) =>
      tx.slidingSync.commit(a, retry, { cut: 20 })
    );
    // Begin without commit models a cancelled response. Neither issued snapshot
    // may disappear before a completed successor consumes the input.
    await tenant.tx((tx) => tx.slidingSync.begin(a, 'room-list', p2));
    const lost = await tenant.tx((tx) =>
      tx.slidingSync.begin(a, 'room-list', p1)
    );
    assertEquals(lost.state, { cut: 10, rooms: {} });
    const p3 = await tenant.tx((tx) =>
      tx.slidingSync.commit(a, lost, { cut: 30 })
    );
    const positions = await store.tenant('sliding.test');
    assertEquals(
      Number(
        (await positions.query(
          'SELECT COUNT(*) AS n FROM sliding_sync_positions',
        ))[0].n,
      ),
      2,
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.begin(a, 'room-list', p2)),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.commit(a, retry, { cut: 99 })),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    const old = await tenant.tx((tx) =>
      tx.slidingSync.begin(a, 'room-list', p1)
    );
    const newer = await tenant.tx((tx) =>
      tx.slidingSync.begin(a, 'room-list', p3)
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.commit(a, old, { cut: 99 })),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    const p4 = await tenant.tx((tx) =>
      tx.slidingSync.commit(a, newer, { cut: 40 })
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.begin(a, 'room-list', p1)),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    await store.close();
    store = await openStore(configuration(dir), {
      schemas: { tenant: tenantSchema },
    });
    tenant = await openTenant(store, 'sliding.test');
    assertEquals(
      (await tenant.tx((tx) => tx.slidingSync.begin(a, 'room-list', p4))).state,
      { cut: 40 },
    );
    await tenant.tx((tx) => tx.devices.delete('PHONE', 'a'));
    await tenant.tx((tx) => tx.devices.upsert('PHONE', 'a', null));
    const replacement = await deviceIdentity(tenant, 'a', 'PHONE');
    await assertRejects(
      () =>
        tenant.tx((tx) => tx.slidingSync.begin(replacement, 'room-list', p4)),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    const db = await store.tenant('sliding.test');
    assertEquals(await db.query('SELECT * FROM sliding_sync_positions'), []);
    assertEquals(await db.query('SELECT * FROM sliding_sync_connections'), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('sliding positions: atomic expiry/capacity/snapshot bounds and initial reset fencing', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(configuration(dir), {
    schemas: { tenant: tenantSchema },
  });
  setConfigForTests({
    slidingsync: {
      connectionseconds: 10,
      maxconnections: 2,
      maxconnectionsperdevice: 1,
      maxsnapshotbytes: 128,
    },
  });
  try {
    const tenant = await openTenant(store, 'limits.test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('a', 'A');
      await tx.devices.upsert('P', 'a', null);
      await tx.devices.upsert('Q', 'a', null);
      await tx.devices.upsert('R', 'a', null);
    });
    const a = await deviceIdentity(tenant, 'a', 'P');
    const q = await deviceIdentity(tenant, 'a', 'Q');
    const r = await deviceIdentity(tenant, 'a', 'R');
    const first = await tenant.tx((tx) =>
      tx.slidingSync.begin(a, 'x', null, 1000)
    );
    const p = await tenant.tx((tx) =>
      tx.slidingSync.commit(a, first, { cut: 1 }, 1000)
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.begin(a, 'y', null, 1000)),
      MatrixError,
      'M_LIMIT_EXCEEDED',
    );
    await tenant.tx((tx) => tx.slidingSync.begin(q, 'x', null, 1000));
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.begin(r, 'x', null, 1000)),
      MatrixError,
      'M_LIMIT_EXCEEDED',
    );
    const kept = await tenant.tx((tx) => tx.slidingSync.begin(a, 'x', p, 1001));
    await assertRejects(
      () =>
        tenant.tx((tx) =>
          tx.slidingSync.commit(a, kept, { payload: 'z'.repeat(128) }, 1001)
        ),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    assertEquals(
      (await tenant.tx((tx) => tx.slidingSync.begin(a, 'x', p, 1001))).state,
      { cut: 1 },
    );
    const reset = await tenant.tx((tx) =>
      tx.slidingSync.begin(a, 'x', null, 1001)
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.commit(a, first, {}, 1001)),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    const fresh = await tenant.tx((tx) =>
      tx.slidingSync.commit(a, reset, {}, 1001)
    );
    await assertRejects(
      () => tenant.tx((tx) => tx.slidingSync.begin(a, 'x', fresh, 11001)),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    await tenant.tx((tx) => tx.slidingSync.begin(r, 'x', null, 11001));
    const db = await store.tenant('limits.test');
    assertEquals(
      Number(
        (await db.query('SELECT COUNT(*) AS n FROM sliding_sync_connections'))[
          0
        ].n,
      ),
      1,
    );
  } finally {
    setConfigForTests({});
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('sliding positions: v18 upgrade keeps account and device data', async () => {
  const dir = await Deno.makeTempDir();
  const previous = {
    version: 18,
    apply: async (db: Parameters<typeof tenantSchema.apply>[0]) => {
      await tenantSchema.apply(db);
      await db.exec(
        'DROP TABLE sliding_sync_positions; DROP TABLE sliding_sync_connections',
      );
    },
  };
  let store = await openStore(configuration(dir), {
    schemas: { tenant: previous },
  });
  try {
    const db = await store.tenant('upgrade.test', { create: true });
    await db.exec(
      "INSERT INTO users(localpart) VALUES('a'); INSERT INTO devices VALUES('P','a',7,'kept')",
    );
    await store.close();
    store = await openStore(configuration(dir), {
      schemas: { tenant: tenantSchema },
    });
    const updated = await store.tenant('upgrade.test');
    assertEquals(
      (await updated.query('SELECT display_name,generation FROM devices'))[0],
      { display_name: 'kept', generation: 7 },
    );
    assertEquals(
      await updated.query('SELECT * FROM sliding_sync_connections'),
      [],
    );
    assertEquals(
      (await updated.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
      String(tenantSchema.version),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
