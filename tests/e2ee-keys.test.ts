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
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';

const limits: KeyLimits = {
  maxrequestbytes: 1048576,
  maxkeybytes: 65536,
  maxkeys: 1000,
  maxonetimekeys: 10000,
  maxinboxmessages: 10000,
  maxdestinationmessages: 1000,
  maxbackupsessions: 100000,
  maxbackupversions: 100,
  maxbackupbytes: 67108864,
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

Deno.test('F2: one upload call owns one durable OTK cohort across algorithms and retries', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    let tenant = await openTenant(store, 'a.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const upload = (keys: Record<string, string>) =>
      tenant.tx((tx) =>
        tx.e2ee.upload(
          device,
          validateUpload(
            { one_time_keys: keys },
            user.user_id,
            'PHONE',
            limits,
          ),
        )
      );
    const cohorts = async () =>
      (await store.tenant('a.test')).query(
        'SELECT algorithm,key_id,upload_pos FROM one_time_keys ORDER BY algorithm,key_id',
      );
    const first = { 'curve25519:z': 'z', 'curve25519:a': 'a', 'other:x': 'x' };
    await upload(first);
    const rows = await cohorts();
    assertEquals(rows.length, 3);
    assertEquals(new Set(rows.map((row) => Number(row.upload_pos))).size, 1);
    const firstPos = Number(rows[0].upload_pos);
    await upload(first);
    assertEquals(await cohorts(), rows);
    await upload({ ...first, 'curve25519:0': 'later' });
    const later = (await cohorts()).find((row) => row.key_id === '0')!;
    assert(Number(later.upload_pos) > firstPos);
    await assertRejects(() =>
      upload({ 'curve25519:new': 'new', 'curve25519:a': 'conflict' })
    );
    assertEquals((await cohorts()).length, 4);
    await store.close();
    store = await openStore(config(dir), { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'a.test');
    const claimed = [];
    for (let n = 0; n < 2; n++) {
      claimed.push(
        await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      );
    }
    assertEquals(
      new Set(claimed.flatMap((value) => Object.keys(value!))),
      new Set(['curve25519:a', 'curve25519:z']),
    );
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:0': 'later' },
    );
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'other')),
      { 'other:x': 'x' },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2: consumed OTK identities remain burned across reupload and cold restart, not fallback reuse or recreation', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    let tenant = await openTenant(store, 'a.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    let device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const input = validateUpload(
      {
        one_time_keys: { 'curve25519:once': 'once' },
        fallback_keys: { 'curve25519:f': 'fallback' },
      },
      user.user_id,
      'PHONE',
      limits,
    );
    await tenant.tx((tx) => tx.e2ee.upload(device, input));
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:once': 'once' },
    );
    await store.close();
    store = await openStore(config(dir), { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'a.test');
    await tenant.tx((tx) => tx.e2ee.upload(device, input));
    assertEquals((await tenant.tx((tx) => tx.e2ee.status(device))).counts, {});
    for (let n = 0; n < 2; n++) {
      assertEquals(
        await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
        { 'curve25519:f': 'fallback' },
      );
    }
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.e2ee.upload(
          device,
          validateUpload(
            {
              one_time_keys: { 'curve25519:once': 'replacement-material' },
            },
            user.user_id,
            'PHONE',
            limits,
          ),
        )
      )
    );
    await deleteDevices(tenant, 'alice', ['PHONE']);
    await upsertDevice(tenant, 'alice', 'PHONE');
    device = await deviceIdentity(tenant, 'alice', 'PHONE');
    await tenant.tx((tx) => tx.e2ee.upload(device, input));
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:once': 'once' },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2: v27 pool upgrade preserves inventory and installs the same irreversible consumption owner as fresh stores', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: { tenant: historicalTenantSchema(27) },
  });
  try {
    await openTenant(store, 'a.test', { create: true });
    const old = await store.tenant('a.test');
    await old.exec(`
      INSERT INTO users(localpart) VALUES('alice');
      INSERT INTO devices VALUES('PHONE','alice',1,NULL);
      INSERT INTO one_time_keys VALUES('alice','PHONE',1,'curve25519','old',5,'"old-key"');
    `);
    await store.close();
    store = await openStore(config(dir), { schemas: { tenant: tenantSchema } });
    const tenant = await openTenant(store, 'a.test');
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      { 'curve25519:old': 'old-key' },
    );
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    await tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            one_time_keys: { 'curve25519:old': 'old-key' },
          },
          '@alice:a.test',
          'PHONE',
          limits,
        ),
      )
    );
    assertEquals(
      await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      null,
    );
    await openTenant(store, 'fresh.test', { create: true });
    const schema = (name: string) =>
      store.tenant(name).then((db) =>
        db.query(
          "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='key_consumptions' ORDER BY type,name",
        )
      );
    assertEquals(await schema('a.test'), await schema('fresh.test'));
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
