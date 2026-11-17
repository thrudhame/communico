import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import {
  deleteDevices,
  updateDeviceName,
  upsertDevice,
} from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { config } from '#engine/config.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { appendDeviceChange } from '#engine/tenant/changes.ts';
import { captureDeviceOperations } from '#engine/tenant/device-source.ts';
import {
  activateTenantAuthority,
  registryDevice,
} from '#engine/tenant/session-authority.ts';

async function fixture(device?: string) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-device-source-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const tenant = await openTenant(store, 'logical.test', { create: true });
  await registerUser(tenant, {
    localpart: 'alice',
    password: 'pw',
    ...(device ? { deviceId: device } : { accessToken: null }),
  });
  const db = await store.tenant('logical.test');
  return {
    tenant,
    db,
    activate: () =>
      db.tx((conn) =>
        activateTenantAuthority(conn, {
          node: 'home',
          incarnation: 'home-store',
          homeIncarnation: 'home-store',
          edgeNode: 'edge',
          edgeIncarnation: 'edge-store',
        })
      ),
    changes: async () =>
      (await db.query(
        'SELECT pos,payload FROM e2ee_changes ORDER BY pos',
      )).map((row) => ({
        pos: Number(row.pos),
        payload: JSON.parse(String(row.payload)),
      })),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('F2 device source captures a pre-enrollment device only with its assigned incarnation', async () => {
  const f = await fixture('PHONE');
  try {
    const device = await deviceIdentity(f.tenant, 'alice', 'PHONE');
    const key = {
      user_id: '@alice:logical.test',
      device_id: 'PHONE',
      algorithms: [],
      keys: { 'ed25519:PHONE': 'public-key' },
      signatures: {},
    };
    await f.tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: key,
            one_time_keys: { 'curve25519:private': 'pool-secret' },
          },
          '@alice:logical.test',
          'PHONE',
          config().e2ee,
        ),
      )
    );
    assert(
      (await f.changes()).every((row) => row.payload.operation === undefined),
    );
    await f.activate();
    await f.db.tx((conn) => captureDeviceOperations(conn, 'alice'));
    const incarnation = await f.db.tx((conn) =>
      registryDevice(conn, 'alice', 'PHONE')
    );
    assert(incarnation);
    const latest = (await f.changes()).at(-1)!;
    const body = {
      version: 1,
      operationId: canonicalJson(['home', 'home-store', 'device', latest.pos]),
      source: 'home',
      incarnation: 'home-store',
      sequence: latest.pos,
      localpart: 'alice',
      deviceId: 'PHONE',
      deviceIncarnation: incarnation.id,
      value: { displayName: 'alice', keys: key },
    };
    assertEquals(latest.payload.operation, {
      ...body,
      payloadHash: createHash('sha256').update(canonicalJson(body)).digest(
        'hex',
      ),
    });
    assertEquals(JSON.stringify(latest.payload).includes('pool-secret'), false);
    const before = await f.changes();
    await f.activate();
    await f.db.tx((conn) => captureDeviceOperations(conn, 'alice'));
    assertEquals(
      await f.changes(),
      before,
      'reopening authority creates no new baseline',
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2 device source upgrades an active owner without relabeling older log rows', async () => {
  const f = await fixture();
  try {
    await f.activate();
    await upsertDevice(f.tenant, 'alice', 'PHONE', 'retained phone');
    // The previous F2 release retained generation-scoped public changes before
    // the semantic source binding existed. Preserve that historical evidence.
    await f.db.execute(
      "UPDATE e2ee_changes SET payload=json_remove(payload,'$.operation')",
    );
    const previous = await f.changes();
    const captured = await f.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    assertEquals(captured.length, 1);
    assertEquals(captured[0].value, {
      displayName: 'retained phone',
      keys: null,
    });
    assertEquals((await f.changes()).slice(0, previous.length), previous);
    assertEquals(
      await f.db.tx((conn) => captureDeviceOperations(conn, 'alice')),
      captured,
    );
    assertEquals((await f.changes()).length, previous.length + 1);
  } finally {
    await f.close();
  }
});

Deno.test('F2 device source binds rename, key update, deletion and recreation without exporting pools', async () => {
  const f = await fixture();
  try {
    await f.activate();
    await upsertDevice(f.tenant, 'alice', 'PHONE');
    await updateDeviceName(f.tenant, 'alice', 'PHONE', 'old phone');
    const device = await deviceIdentity(f.tenant, 'alice', 'PHONE');
    const key = {
      user_id: '@alice:logical.test',
      device_id: 'PHONE',
      algorithms: [],
      keys: { 'ed25519:PHONE': 'old-key' },
      signatures: {},
    };
    const upload = (body: unknown) =>
      f.tenant.tx((tx) =>
        tx.e2ee.upload(
          device,
          validateUpload(body, '@alice:logical.test', 'PHONE', config().e2ee),
        )
      );
    await upload({ device_keys: key });
    const old = await f.db.tx((conn) => registryDevice(conn, 'alice', 'PHONE'));
    assert(old);
    const before = await f.changes();
    await upload({ one_time_keys: { 'curve25519:private': 'pool-secret' } });
    assertEquals(
      await f.changes(),
      before,
      'pool-only mutations are not public device facts',
    );
    await assertRejects(
      () =>
        f.db.tx(async (conn) => {
          await conn.execute(
            "UPDATE devices SET display_name='rolled back' WHERE device_id='PHONE'",
          );
          await appendDeviceChange(conn, device);
          throw new Error('abort device intent');
        }),
      Error,
      'abort device intent',
    );
    assertEquals(await f.changes(), before);
    await deleteDevices(f.tenant, 'alice', ['PHONE']);
    await upsertDevice(f.tenant, 'alice', 'PHONE', 'new phone');
    const current = await f.db.tx((conn) =>
      registryDevice(conn, 'alice', 'PHONE')
    );
    assert(current && current.id !== old.id);
    const rows = await f.changes();
    assertEquals(rows.length, 5);
    assert(
      rows.every((row) => row.payload.operation),
      'every owned public change has a semantic source intent',
    );
    assertEquals(rows.map((row) => row.payload.operation.deviceIncarnation), [
      old.id,
      old.id,
      old.id,
      old.id,
      current.id,
    ]);
    assertEquals(rows.map((row) => row.payload.operation.value), [
      { displayName: null, keys: null },
      { displayName: 'old phone', keys: null },
      { displayName: 'old phone', keys: key },
      null,
      { displayName: 'new phone', keys: null },
    ]);
    assertEquals(
      new Set(rows.map((row) => row.payload.operation.operationId)).size,
      5,
    );
    for (const row of rows) {
      const { payloadHash, ...body } = row.payload.operation;
      assertEquals(
        payloadHash,
        createHash('sha256').update(canonicalJson(body)).digest('hex'),
      );
      assertEquals(body.sequence, row.pos);
    }
    assertEquals(JSON.stringify(rows).includes('pool-secret'), false);
  } finally {
    await f.close();
  }
});

Deno.test('F2 device source cannot silently export an incomplete generation binding', async () => {
  const f = await fixture();
  try {
    await f.activate();
    await upsertDevice(f.tenant, 'alice', 'PHONE');
    await f.db.execute('UPDATE authority_devices SET generation=generation+1');
    const before = await f.changes();
    await assertRejects(
      () => f.db.tx((conn) => captureDeviceOperations(conn, 'alice')),
      Error,
      'public device intent lacks its owning incarnation',
    );
    assertEquals(await f.changes(), before);
  } finally {
    await f.close();
  }
});
