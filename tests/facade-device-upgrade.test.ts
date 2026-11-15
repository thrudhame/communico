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
    schemas: { tenant: historicalTenantSchema(28) },
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
