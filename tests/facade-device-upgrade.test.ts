import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { upsertDevice } from '#engine/tenant/devices.ts';
import { captureDeviceOperations } from '#engine/tenant/device-source.ts';
import {
  importDeviceOperation,
  publicDeviceValues,
} from '#engine/tenant/device-operations.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';

Deno.test('F2 complete-view checkpoints upgrade tenant37 with no fabricated snapshots and match fresh schema', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-checkpoint-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(37) },
  });
  try {
    await openTenant(store, 'logical.test', { create: true });
    const old = await store.tenant('logical.test');
    await old.execute("INSERT INTO user_device_stream VALUES('alice',10)");
    const retained = await old.query('SELECT * FROM user_device_stream');
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const db = await store.tenant('logical.test');
    assertEquals(await db.query('SELECT * FROM device_stream_checkpoints'), []);
    assertEquals(await db.query('SELECT * FROM user_device_stream'), retained);
    const sql =
      "SELECT name,sql FROM sqlite_master WHERE name LIKE 'device_stream_%' ORDER BY name";
    await openTenant(store, 'fresh.test', { create: true });
    assertEquals(
      await db.query(sql),
      await (await store.tenant('fresh.test')).query(sql),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2 wire frontier upgrades tenant36 without inventing original publication evidence', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-device-wire-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(36) },
  });
  try {
    await openTenant(store, 'logical.test', { create: true });
    const old = await store.tenant('logical.test');
    await old.execute("INSERT INTO user_device_stream VALUES('alice',10)");
    await old.execute(
      'INSERT INTO e2ee_changes VALUES(1,\'alice\',\'OLD\',1,10,\'{"device_id":"OLD","deleted":true}\')',
    );
    const retained = await old.query('SELECT * FROM e2ee_changes');
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const db = await store.tenant('logical.test');
    for (
      const table of [
        'device_stream_publications',
        'device_stream_predecessors',
        'device_stream_frontier',
        'device_stream_baselines',
      ]
    ) {
      assertEquals(await db.query('SELECT * FROM ' + table), []);
    }
    assertEquals(await db.query('SELECT * FROM e2ee_changes'), retained);
    const sql =
      "SELECT name,sql FROM sqlite_master WHERE name LIKE 'device_stream_%' ORDER BY name";
    const upgraded = await db.query(sql);
    await openTenant(store, 'fresh.test', { create: true });
    assertEquals(await (await store.tenant('fresh.test')).query(sql), upgraded);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2 public device schema upgrades the prior pool owner and retains imported facts on reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-device-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(30) },
  });
  try {
    let tenant = await openTenant(store, 'logical.test', { create: true });
    await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      accessToken: null,
    });
    let db = await store.tenant('logical.test');
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'home',
        incarnation: 'home-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    await upsertDevice(tenant, 'alice', 'LAN', 'retained device');
    const captured = await db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'logical.test');
    db = await store.tenant('logical.test');
    for (const op of captured) {
      await db.tx((conn) =>
        importDeviceOperation(conn, op, {
          source: 'home',
          incarnation: 'home-store',
          localpart: 'alice',
        })
      );
    }
    const before = await db.tx((conn) => publicDeviceValues(conn, 'alice'));
    const schema = await db.query(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('device_operations','device_operations_account') ORDER BY name",
    );
    const fresh = await openTenant(store, 'fresh.test', { create: true });
    assertEquals(
      schema,
      await (await store.tenant(fresh.serverName)).query(
        "SELECT name,sql FROM sqlite_master WHERE name IN ('device_operations','device_operations_account') ORDER BY name",
      ),
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    db = await store.tenant('logical.test');
    assertEquals(
      await db.tx((conn) => publicDeviceValues(conn, 'alice')),
      before,
    );
    assertEquals(
      (await db.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
      String(tenantSchema.version),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2 key bootstrap upgrades tenant34 without manufacturing completeness and matches fresh schema', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'facade-key-bootstrap-upgrade-',
  });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(34) },
  });
  try {
    await openTenant(store, 'logical.test', { create: true });
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const db = await store.tenant('logical.test');
    assertEquals(
      await db.query('SELECT * FROM key_bootstrap_publications'),
      [],
    );
    const sql =
      "SELECT name,sql FROM sqlite_master WHERE name='key_bootstrap_publications'";
    const upgraded = await db.query(sql);
    assertEquals(upgraded.length, 1);
    await openTenant(store, 'fresh.test', { create: true });
    assertEquals(await (await store.tenant('fresh.test')).query(sql), upgraded);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2 passive device creation history upgrades tenant35 without manufacturing registry authority', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'facade-device-history-upgrade-',
  });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(35) },
  });
  try {
    await openTenant(store, 'logical.test', { create: true });
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const db = await store.tenant('logical.test');
    assertEquals(await db.query('SELECT * FROM device_creation_history'), []);
    assertEquals(await db.query('SELECT * FROM authority_facts'), []);
    const sql =
      "SELECT name,sql FROM sqlite_master WHERE name='device_creation_history'";
    const schema = await db.query(sql);
    assertEquals(schema.length, 1);
    await openTenant(store, 'fresh.test', { create: true });
    assertEquals(await (await store.tenant('fresh.test')).query(sql), schema);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
