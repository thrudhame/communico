import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { setTenantProjector } from '#engine/tenant/hooks.ts';
import {
  changePassword,
  deactivateUser,
  registerUser,
} from '#engine/tenant/users.ts';
import { revokeAllTokens, revokeToken } from '#engine/tenant/auth.ts';
import { deleteDevices, upsertDevice } from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { type KeyLimits, validateUpload } from '#engine/tenant/e2ee.ts';

const limits: KeyLimits = {
  maxrequestbytes: 1048576,
  maxkeybytes: 65536,
  maxkeys: 1000,
  maxonetimekeys: 10000,
  maxinboxmessages: 10000,
  maxdestinationmessages: 1000,
  maxbackupsessions: 100000,
  maxbackupversions: 100,
};
const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

for (
  const action of ['logout', 'logout-all', 'password', 'deactivate'] as const
) {
  Deno.test(
    'E1: ' + action +
      ' removes owned keys, fallback and OTKs without touching another user',
    async () => {
      const dir = await Deno.makeTempDir();
      const store = await openStore(config(dir), {
        schemas: { tenant: tenantSchema },
      });
      try {
        const tenant = await openTenant(store, 'a.test', { create: true });
        const users = await Promise.all(
          ['alice', 'bob'].map((localpart) =>
            registerUser(tenant, {
              localpart,
              password: 'pw',
              deviceId: 'PHONE',
            })
          ),
        );
        for (const [n, localpart] of ['alice', 'bob'].entries()) {
          const device = await deviceIdentity(tenant, localpart, 'PHONE');
          const keys = {
            user_id: users[n].user_id,
            device_id: 'PHONE',
            algorithms: [],
            keys: {},
            signatures: {},
          };
          const input = validateUpload(
            {
              device_keys: keys,
              one_time_keys: { 'curve25519:once': 'once' },
              fallback_keys: { 'curve25519:f': 'fallback' },
            },
            users[n].user_id,
            'PHONE',
            limits,
          );
          await tenant.tx((tx) => tx.e2ee.upload(device, input));
        }
        if (action === 'logout') {
          await revokeToken(tenant, users[0].access_token!);
        }
        if (action === 'logout-all') await revokeAllTokens(tenant, 'alice');
        if (action === 'password') {
          await changePassword(tenant, 'alice', 'new', { logoutDevices: true });
        }
        if (action === 'deactivate') await deactivateUser(tenant, 'alice');
        assertEquals(
          await tenant.tx((tx) =>
            tx.e2ee.query(
              'alice',
              [],
              users[1].user_id,
              users[0].user_id,
              limits.maxkeys,
            )
          ),
          {},
        );
        assertEquals(
          await tenant.tx((tx) =>
            tx.e2ee.claim('alice', 'PHONE', 'curve25519')
          ),
          null,
        );
        assertEquals(
          await tenant.tx((tx) => tx.e2ee.claim('bob', 'PHONE', 'curve25519')),
          { 'curve25519:once': 'once' },
        );
        await upsertDevice(tenant, 'alice', 'PHONE');
        assertEquals(
          await tenant.tx((tx) =>
            tx.e2ee.claim('alice', 'PHONE', 'curve25519')
          ),
          null,
        );
        const replacement = await deviceIdentity(tenant, 'alice', 'PHONE');
        assertEquals(
          (await tenant.tx((tx) => tx.e2ee.status(replacement))).unused,
          [],
        );
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}

Deno.test('E1: tenant commit survives projection interruption; replay cannot resurrect consumed OTKs', async () => {
  const dir = await Deno.makeTempDir();
  installServerHooks();
  let store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema, server: serverSchema },
  });
  try {
    setTenantProjector(undefined); // Crash window: tenant committed, server not yet projected.
    const tenant = await openTenant(store, 'a.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const key = {
      user_id: user.user_id,
      device_id: 'PHONE',
      algorithms: [],
      keys: {},
      signatures: {
        [user.user_id]: { 'ed25519:PHONE': 'owner' },
        '@private:b.test': { 'ed25519:master': 'private' },
      },
      extension: 'kept',
    };
    await tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: key,
            one_time_keys: {
              'curve25519:first': 'first',
              'curve25519:second': 'second',
            },
          },
          user.user_id,
          'PHONE',
          limits,
        ),
      )
    );
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:first': 'first' },
    );
    assertEquals(
      await (await store.server()).query('SELECT * FROM device_changes'),
      [],
    );
    await store.close();
    store = await openStore(config(dir), {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    const reopened = await openTenant(store, 'a.test');
    const changes = await (await store.server()).query(
      'SELECT * FROM device_changes ORDER BY seq',
    );
    assertEquals(changes.length, 2);
    assertEquals(JSON.parse(String(changes[1].payload)).keys, {
      ...key,
      signatures: { [user.user_id]: key.signatures[user.user_id] },
    });
    await projectTenant(store, 'a.test');
    assertEquals(
      await (await store.server()).query(
        'SELECT * FROM device_changes ORDER BY seq',
      ),
      changes,
    );
    assertEquals((await reopened.tx((tx) => tx.e2ee.status(device))).counts, {
      curve25519: 1,
    });
    assertEquals(
      await reopened.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:second': 'second' },
    );
    assertEquals(
      await reopened.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      null,
    );
    await deleteDevices(reopened, 'alice', ['PHONE']);
    await projectTenant(store, 'a.test');
    const tombstone = await (await store.server()).query(
      'SELECT payload FROM device_changes ORDER BY seq DESC LIMIT 1',
    );
    assertEquals(JSON.parse(String(tombstone[0].payload)).deleted, true);
    await upsertDevice(reopened, 'alice', 'PHONE');
    assert(
      (await deviceIdentity(reopened, 'alice', 'PHONE')).generation >
        device.generation,
    );
  } finally {
    setTenantProjector(undefined);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E1: simultaneous claims consume each accepted key once; upload ordering and conflict rollback', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'a.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const keys = Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => ['curve25519:' + n, 'key-' + n]),
    );
    const upload = (body: unknown) =>
      tenant.tx((tx) =>
        tx.e2ee.upload(
          device,
          validateUpload(body, user.user_id, 'PHONE', limits),
        )
      );
    await upload({ one_time_keys: keys });
    await assertRejects(() =>
      upload({
        one_time_keys: {
          'curve25519:extra': 'extra',
          'curve25519:0': 'conflict',
        },
      })
    );
    const claims = await Promise.all(
      Array.from(
        { length: 12 },
        () => tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      ),
    );
    assertEquals(new Set(claims.map((key) => Object.keys(key!)[0])).size, 12);
    assertEquals((await tenant.tx((tx) => tx.e2ee.status(device))).counts, {});
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      null,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E1: pool overflow rejects the entire mutation and leaves accepted keys claimable', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'a.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const constrained = { ...limits, maxonetimekeys: 1 };
    const upload = (body: unknown) =>
      tenant.tx((tx) =>
        tx.e2ee.upload(
          device,
          validateUpload(body, user.user_id, 'PHONE', constrained),
        )
      );
    await upload({ one_time_keys: { 'curve25519:first': 'first' } });
    await assertRejects(() =>
      upload({
        one_time_keys: { 'curve25519:second': 'second' },
        fallback_keys: { 'curve25519:f': 'fallback' },
      })
    );
    const status = await tenant.tx((tx) => tx.e2ee.status(device));
    assertEquals(status.counts, { curve25519: 1 });
    assertEquals(status.unused, []);
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:first': 'first' },
    );
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      null,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E1: retained fallbacks and pool status stay bounded across uploads and concurrent writers', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'a.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const constrained = { ...limits, maxkeys: 2 };
    const upload = (body: unknown, cap = constrained) =>
      tenant.tx((tx) =>
        tx.e2ee.upload(device, validateUpload(body, user.user_id, 'PHONE', cap))
      );
    await upload({ fallback_keys: { 'a:first': 'first' } });
    await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'a'));
    const result = await Promise.allSettled(
      ['b', 'c'].map((algorithm) =>
        upload({ fallback_keys: { [algorithm + ':key']: algorithm } })
      ),
    );
    assertEquals(result.filter((r) => r.status === 'fulfilled').length, 1);
    assertEquals(result.filter((r) => r.status === 'rejected').length, 1);
    assertEquals(
      (await tenant.tx((tx) => tx.e2ee.status(device))).unused.length,
      1,
    );
    // Used fallbacks remain stored and count toward the same aggregate limit.
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'a')),
      { 'a:first': 'first' },
    );
    await upload({ fallback_keys: { 'a:replacement': 'replacement' } });
    const before = await tenant.tx((tx) => tx.e2ee.status(device));
    const algorithm = 'x'.repeat(100);
    const body = { one_time_keys: { [algorithm + ':1']: 'one' } };
    await assertRejects(() =>
      upload(body, {
        ...constrained,
        maxrequestbytes: JSON.stringify(body).length,
      })
    );
    assertEquals(await tenant.tx((tx) => tx.e2ee.status(device)), before);
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', algorithm)),
      null,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
