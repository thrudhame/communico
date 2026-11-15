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
import {
  captureDeviceOperations,
  type DeviceOperation,
} from '#engine/tenant/device-source.ts';
import {
  activateTenantAuthority,
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import * as operations from '#engine/tenant/device-operations.ts';
import { config } from '#engine/config.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';

const expected = {
  source: 'edge',
  incarnation: 'edge-store',
  localpart: 'alice',
};
async function fixture(node: 'home' | 'edge') {
  const dir = await Deno.makeTempDir({ prefix: 'facade-device-operations-' });
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
    accessToken: null,
  });
  const db = await store.tenant('logical.test');
  await db.tx((conn) =>
    activateTenantAuthority(conn, {
      node,
      incarnation: node + '-store',
      homeIncarnation: 'home-store',
      edgeNode: 'edge',
      edgeIncarnation: 'edge-store',
    })
  );
  return {
    db,
    tenant,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
function rehash(op: DeviceOperation): DeviceOperation {
  const { payloadHash: _hash, ...body } = op;
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}
async function setup() {
  const home = await fixture('home'), edge = await fixture('edge');
  await upsertDevice(home.tenant, 'alice', 'LAN', 'home device');
  await upsertDevice(edge.tenant, 'alice', 'PHONE', 'outside device');
  await updateDeviceName(edge.tenant, 'alice', 'PHONE', 'new name');
  const device = await deviceIdentity(edge.tenant, 'alice', 'PHONE');
  await edge.tenant.tx((tx) =>
    tx.e2ee.upload(
      device,
      validateUpload(
        {
          device_keys: {
            user_id: '@alice:logical.test',
            device_id: 'PHONE',
            algorithms: [],
            keys: { 'ed25519:PHONE': 'owner-key' },
            signatures: {},
          },
          one_time_keys: { 'curve25519:private': 'never-export-pool' },
        },
        '@alice:logical.test',
        'PHONE',
        config().e2ee,
      ),
    )
  );
  const facts = await edge.db.tx((conn) =>
    captureSessionAuthority(conn, 'alice')
  );
  const captured = await edge.db.tx((conn) =>
    captureDeviceOperations(conn, 'alice')
  );
  return {
    home,
    edge,
    facts,
    captured,
    async close() {
      await home.close();
      await edge.close();
    },
  };
}

Deno.test('F2 public device owner retains immutable operations without importing execution authority', async () => {
  const f = await setup();
  try {
    await f.home.db.tx((conn) =>
      installSessionAuthority(conn, 'alice', f.facts)
    );
    for (const op of [...f.captured].reverse()) {
      await f.home.db.tx((conn) =>
        operations.importDeviceOperation(conn, op, expected)
      );
    }
    for (const op of f.captured) {
      await f.home.db.tx((conn) =>
        operations.importDeviceOperation(conn, op, expected)
      );
    }
    const view = await f.home.db.tx((conn) =>
      operations.publicDeviceValues(conn, 'alice')
    );
    assertEquals(view.map((op) => [op.deviceId, op.value?.displayName]), [[
      'LAN',
      'home device',
    ], ['PHONE', 'new name']]);
    assertEquals(
      view.find((op) => op.deviceId === 'PHONE')?.value?.keys?.keys,
      { 'ed25519:PHONE': 'owner-key' },
    );
    assertEquals(JSON.stringify(view).includes('never-export-pool'), false);
    assertEquals(
      (await f.home.db.query(
        'SELECT device_id FROM devices ORDER BY device_id',
      )).map((row) => row.device_id),
      ['LAN'],
    );
    for (
      const table of [
        'one_time_keys',
        'fallback_keys',
        'access_tokens',
        'refresh_tokens',
      ]
    ) assertEquals(await f.home.db.query('SELECT * FROM ' + table), []);
    assertEquals(
      (await f.home.db.query('SELECT * FROM device_operations')).length,
      f.captured.length,
    );
    const local = await f.home.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    assert(
      local.every((op) => op.source === 'home'),
      'imported intent is never reauthored',
    );
    await assertRejects(
      () =>
        f.home.db.tx((conn) =>
          operations.importDeviceOperation(
            conn,
            rehash({
              ...f.captured[0],
              value: { displayName: 'substituted', keys: null },
            }),
            expected,
          )
        ),
      Error,
      'device operation collision',
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2 public device owner needs authentic matching incarnation facts before retaining material', async () => {
  const f = await setup();
  try {
    await assertRejects(
      () =>
        f.home.db.tx((conn) =>
          operations.importDeviceOperation(conn, f.captured[0], expected)
        ),
      Error,
      'device operation awaits incarnation',
    );
    assertEquals(await f.home.db.query('SELECT * FROM device_operations'), []);
    await f.home.db.tx((conn) =>
      installSessionAuthority(conn, 'alice', f.facts)
    );
    for (
      const op of [
        rehash({ ...f.captured[0], source: 'home' }),
        rehash({ ...f.captured[0], localpart: 'bob' }),
        rehash({ ...f.captured[0], deviceId: 'ANOTHER' }),
        { ...f.captured[0], payloadHash: '0'.repeat(64) },
        rehash({
          ...f.captured[0],
          value: {
            displayName: null,
            keys: { user_id: '@mallory:logical.test', device_id: 'PHONE' },
          },
        }),
        { ...f.captured[0], pool: { secret: true } },
      ]
    ) {
      await assertRejects(
        () =>
          f.home.db.tx((conn) =>
            operations.importDeviceOperation(conn, op, expected)
          ),
        Error,
      );
    }
    assertEquals(await f.home.db.query('SELECT * FROM device_operations'), []);
    await assertRejects(
      () =>
        f.home.db.tx(async (conn) => {
          await operations.importDeviceOperation(conn, f.captured[0], expected);
          throw new Error('abort');
        }),
      Error,
      'abort',
    );
    assertEquals(await f.home.db.query('SELECT * FROM device_operations'), []);
  } finally {
    await f.close();
  }
});

Deno.test('F2 returned local device history cannot substitute a tombstone under an existing source identity', async () => {
  const f = await setup();
  try {
    const [local] = await f.home.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    await assertRejects(
      () =>
        f.home.db.tx((conn) =>
          operations.importDeviceOperation(
            conn,
            rehash({ ...local, value: null }),
            local,
          )
        ),
      Error,
      'device operation collision',
    );
    assertEquals(
      (await f.home.db.tx((conn) =>
        operations.publicDeviceValues(conn, 'alice')
      )).map((op) => op.deviceId),
      ['LAN'],
    );
    assertEquals(await f.home.db.query('SELECT * FROM device_operations'), []);
  } finally {
    await f.close();
  }
});

Deno.test('F2 public device owner removes stale generations, collision losers and deleted incarnations in every order', async () => {
  const f = await setup();
  try {
    await deleteDevices(f.edge.tenant, 'alice', ['PHONE']);
    await upsertDevice(f.edge.tenant, 'alice', 'PHONE', 'replacement');
    const all = await f.edge.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    const facts = await f.edge.db.tx((conn) =>
      captureSessionAuthority(conn, 'alice')
    );
    await f.home.db.tx((conn) => installSessionAuthority(conn, 'alice', facts));
    for (const op of [...all].reverse()) {
      await f.home.db.tx((conn) =>
        operations.importDeviceOperation(conn, op, expected)
      );
    }
    let view = await f.home.db.tx((conn) =>
      operations.publicDeviceValues(conn, 'alice')
    );
    assertEquals(
      view.find((op) => op.deviceId === 'PHONE')?.value?.displayName,
      'replacement',
    );
    await upsertDevice(f.home.tenant, 'alice', 'COLLISION', 'home wins');
    await upsertDevice(f.edge.tenant, 'alice', 'COLLISION', 'edge loses');
    const collisionFacts = await f.edge.db.tx((conn) =>
      captureSessionAuthority(conn, 'alice')
    );
    await f.home.db.tx((conn) =>
      installSessionAuthority(conn, 'alice', collisionFacts)
    );
    const collisionOps = await f.edge.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    for (const op of collisionOps) {
      await f.home.db.tx((conn) =>
        operations.importDeviceOperation(conn, op, expected)
      );
    }
    view = await f.home.db.tx((conn) =>
      operations.publicDeviceValues(conn, 'alice')
    );
    assertEquals(
      view.find((op) => op.deviceId === 'COLLISION')?.value?.displayName,
      'home wins',
    );
    await deleteDevices(f.edge.tenant, 'alice', ['PHONE']);
    const deleted = await f.edge.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    for (const op of [...deleted].reverse()) {
      await f.home.db.tx((conn) =>
        operations.importDeviceOperation(conn, op, expected)
      );
    }
    assertEquals(
      (await f.home.db.tx((conn) =>
        operations.publicDeviceValues(conn, 'alice')
      )).some((op) => op.deviceId === 'PHONE'),
      false,
      'public tombstone wins even before the next auth exchange',
    );
    for (const op of all) {
      await f.home.db.tx((conn) =>
        operations.importDeviceOperation(conn, op, expected)
      );
    }
    assertEquals(
      (await f.home.db.tx((conn) =>
        operations.publicDeviceValues(conn, 'alice')
      )).some((op) => op.deviceId === 'PHONE'),
      false,
    );
  } finally {
    await f.close();
  }
});
