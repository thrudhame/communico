import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  deactivateUser,
  deactivateUserRows,
  registerUser,
} from '#engine/tenant/users.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';

const settings = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('deactivation clears private account state without requiring public-history erasure on either ingress', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'deactivation-private-' });
  const store = await openStore(settings(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'logical.test', { create: true });
    for (const localpart of ['local', 'imported', 'active']) {
      await registerUser(tenant, { localpart, password: 'pw' });
      await tenant.tx(async (tx) => {
        await tx.accountData.put(
          localpart,
          '',
          'm.secret_storage.key.key',
          '{"encrypted":"retained"}',
          1,
        );
        await tx.filters.insert(localpart, 'filter', '{}');
        await tx.pushRules.put(
          localpart,
          'override',
          'private',
          1,
          '["notify"]',
          '[]',
          null,
          1,
        );
      });
    }
    await deactivateUser(tenant, 'local');
    await (await store.tenant('logical.test')).tx((conn) =>
      deactivateUserRows(conn, 'logical.test', 'imported', undefined, true)
    );
    for (const localpart of ['local', 'imported']) {
      assertEquals(
        await tenant.tx((tx) =>
          tx.accountData.get(localpart, '', 'm.secret_storage.key.key')
        ),
        null,
      );
      assertEquals(await tenant.tx((tx) => tx.filters.count(localpart)), 0);
      assertEquals(
        await tenant.tx((tx) =>
          tx.pushRules.byId(localpart, 'override', 'private')
        ),
        null,
      );
    }
    assertEquals(await tenant.tx((tx) => tx.filters.count('active')), 1);
    assertEquals(
      await (await store.tenant('logical.test')).query(
        'SELECT localpart FROM erased_users',
      ),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('deactivation work is atomic, remove-wins and durable for local and imported cleanup', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'deactivation-work-' });
  let store = await openStore(settings(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'logical.test', { create: true });
    for (const localpart of ['local', 'imported', 'rollback']) {
      await registerUser(tenant, { localpart, password: 'pw' });
    }
    await deactivateUser(tenant, 'local');
    const db = await store.tenant('logical.test');
    await db.tx((conn) =>
      deactivateUserRows(conn, 'logical.test', 'imported', {}, true)
    );
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          await deactivateUserRows(conn, 'logical.test', 'rollback');
          throw new Error('before deactivation commit');
        }),
      Error,
      'before deactivation commit',
    );
    assertEquals(
      await db.query(
        'SELECT localpart,erase FROM deactivation_work ORDER BY localpart',
      ),
      [
        { localpart: 'imported', erase: 1 },
        { localpart: 'local', erase: 0 },
      ],
    );
    assertEquals(
      (await db.query(
        "SELECT deactivated FROM users WHERE localpart='rollback'",
      ))[0].deactivated,
      0,
    );
    await deactivateUser(tenant, 'local', {});
    await deactivateUser(tenant, 'local');
    await db.tx((conn) =>
      deactivateUserRows(conn, 'logical.test', 'imported', undefined, true)
    );
    await store.close();
    store = await openStore(settings(dir), {
      schemas: { tenant: tenantSchema },
    });
    assertEquals(
      await (await store.tenant('logical.test')).query(
        'SELECT localpart,erase FROM deactivation_work ORDER BY localpart',
      ),
      [
        { localpart: 'imported', erase: 1 },
        { localpart: 'local', erase: 1 },
      ],
    );
    assertEquals(
      await (await store.tenant('logical.test')).query(
        'SELECT localpart FROM erased_users ORDER BY localpart',
      ),
      [
        { localpart: 'imported' },
        { localpart: 'local' },
      ],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('deactivation work upgrade recovers outstanding cleanup from actual tenant25 tombstones', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'deactivation-upgrade-' });
  let store = await openStore(settings(dir), {
    schemas: { tenant: historicalTenantSchema(25) },
  });
  try {
    const tenant = await openTenant(store, 'logical.test', { create: true });
    for (const localpart of ['active', 'deactivated', 'erased']) {
      await registerUser(tenant, { localpart, password: 'pw' });
    }
    await (await store.tenant('logical.test')).tx(async (conn) => {
      await conn.execute(
        "UPDATE users SET deactivated=1 WHERE localpart<>'active'",
      );
      await conn.execute(
        "INSERT INTO erased_users(localpart,room_cuts) VALUES('erased','{}')",
      );
    });
    await store.close();
    store = await openStore(settings(dir), {
      schemas: { tenant: tenantSchema },
    });
    assertEquals(
      (await openTenant(store, 'logical.test')).publicB64,
      tenant.publicB64,
    );
    assertEquals(
      await (await store.tenant('logical.test')).query(
        'SELECT localpart,erase FROM deactivation_work ORDER BY localpart',
      ),
      [
        { localpart: 'deactivated', erase: 0 },
        { localpart: 'erased', erase: 1 },
      ],
    );
    const fresh = await openStore(settings(dir + '/fresh'), {
      schemas: { tenant: tenantSchema },
    });
    try {
      await openTenant(fresh, 'logical.test', { create: true });
      const sql =
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      assertEquals(
        await (await store.tenant('logical.test')).query(sql),
        await (await fresh.tenant('logical.test')).query(sql),
      );
    } finally {
      await fresh.close();
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
