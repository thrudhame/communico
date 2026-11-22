import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { issueToken, revokeToken } from '#engine/tenant/auth.ts';
import { setPusher } from '#engine/tenant/pushers.ts';
import {
  completedTenantProjection,
  completeTenantProjection,
  pendingTenantProjection,
  recordTenantProjection,
  setTenantProjector,
  tenantChangesCommitted,
} from '#engine/tenant/hooks.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/index.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { startPushSender } from '#engine/push/sender.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import { hashPassword, loginUser } from '#engine/tenant/users.ts';

installServerHooks();

async function fixture() {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    tenant: tenantSchema,
    server: serverSchema,
    room: roomSchema,
  };
  let store = await openStore(options, { schemas });
  let tenant = await openTenant(store, 'test', { create: true });
  await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
  const token = await issueToken(tenant, 'bob', 'B');
  await projectTenant(store, 'test');
  return {
    get store() {
      return store;
    },
    get tenant() {
      return tenant;
    },
    token,
    register: () =>
      setPusher(tenant, 'bob', token, {
        app_id: 'app',
        pushkey: 'key',
        kind: 'http',
        app_display_name: 'App',
        device_display_name: 'B',
        lang: 'en',
        data: { url: 'https://push.test/_matrix/push/v1/notify' },
      }),
    pending: async () =>
      (await store.tenant('test')).query(
        "SELECT value FROM counters WHERE name='projection_pending'",
      ),
    reopen: async (beforeStartup?: (store: Store) => Promise<unknown>) => {
      await store.close();
      store = await openStore(options, { schemas, beforeStartup });
      tenant = await openTenant(store, 'test');
    },
    close: async () => {
      setTenantProjector(projectTenant);
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('review projection: completed progress survives cold reopen and preserves newer recovery debt', async () => {
  const f = await fixture();
  try {
    let db = await f.store.tenant('test');
    const old = await db.tx(recordTenantProjection);
    await projectTenant(f.store, 'test');
    const later = await db.tx(recordTenantProjection);
    await completeTenantProjection(f.store, 'test', db, old);
    assertEquals(await pendingTenantProjection(db), later);
    let projections = 0;
    setTenantProjector((...args: Parameters<typeof projectTenant>) => {
      projections++;
      return projectTenant(...args);
    });
    // Inspect the actual reopened file before normal startup roll-forward;
    // startup must then remain free to recover the independently newer debt.
    await f.reopen(async (cold) => {
      const reopened = await cold.tenant('test');
      assertEquals(await completedTenantProjection(reopened), old);
      await tenantChangesCommitted(cold, 'test', old);
      assertEquals(projections, 0);
      assertEquals(await pendingTenantProjection(reopened), later);
    });
    db = await f.store.tenant('test');
    assertEquals(await completedTenantProjection(db), later);
    assertEquals(await pendingTenantProjection(db), 0);
    const newest = await db.tx(recordTenantProjection);
    await tenantChangesCommitted(f.store, 'test', newest);
    assertEquals(projections, 1);
    assertEquals(await completedTenantProjection(db), newest);
    assertEquals(await pendingTenantProjection(db), 0);
  } finally {
    await f.close();
  }
});

Deno.test('review projection: post-commit progress lookup failure leaves successful mutation recoverable', async () => {
  const f = await fixture();
  const original = f.store.tenant.bind(f.store);
  try {
    setTenantProjector(projectTenant);
    f.store.tenant = () =>
      Promise.reject(new Error('projection metadata unavailable'));
    await f.register();
    f.store.tenant = original;
    assert(Number((await f.pending())[0].value) > 0);
    assertEquals(
      await (await f.store.server()).query('SELECT * FROM push_targets'),
      [],
    );
    await projectTenant(f.store, 'test');
    assertEquals(await f.pending(), []);
    assertEquals(
      (await (await f.store.server()).query('SELECT * FROM push_targets'))
        .length,
      1,
    );
  } finally {
    f.store.tenant = original;
    await f.close();
  }
});

Deno.test('tenant projection: unchanged mutations and same-device login create no projection work or notices', async () => {
  const f = await fixture();
  let notices = 0;
  const off = onTenantStream((store) => {
    if (store === f.store) notices++;
  });
  try {
    setTenantProjector(undefined);
    await f.tenant.tx((tx) => tx.credentials.set('bob', hashPassword('pw')));
    const db = await f.store.tenant('test');
    const before = await db.query(
      "SELECT value FROM counters WHERE name='projection_revision'",
    );
    await f.tenant.tx((tx) => tx.devices.upsert('B', 'bob', null));
    assertEquals(
      await f.pending(),
      [],
      'an unchanged device is not projection work',
    );
    await f.tenant.tx((tx) => tx.devices.rename('B', 'bob', 'same-name'));
    await projectTenant(f.store, 'test');
    const renamed = await db.query(
      "SELECT value FROM counters WHERE name='projection_revision'",
    );
    assert(Number(renamed[0].value) > Number(before[0].value));
    notices = 0;
    await f.tenant.tx((tx) => tx.devices.rename('B', 'bob', 'same-name'));
    await f.tenant.tx((tx) => tx.devices.delete('absent', 'bob'));
    assertEquals(
      await f.tenant.tx((tx) => tx.e2ee.claim('bob', 'B', 'curve25519')),
      null,
    );
    await loginUser(f.tenant, {
      localpart: 'bob',
      password: 'pw',
      deviceId: 'B',
      refresh: false,
    });
    assertEquals(
      await f.pending(),
      [],
      'same-device auth and empty consuming reads must not compete with imported authority',
    );
    assertEquals(
      await db.query(
        "SELECT value FROM counters WHERE name='projection_revision'",
      ),
      renamed,
    );
    assertEquals(notices, 0);
  } finally {
    off();
    await f.close();
  }
});

Deno.test('tenant projection: missed post-commit hook retains a durable revision and worker recovers registration and revocation', async () => {
  const f = await fixture();
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: () => Promise.resolve([]),
  });
  try {
    setTenantProjector(undefined);
    await f.register();
    const pending = await f.pending();
    assertEquals(pending.length, 1);
    const revision = Number(pending[0].value);
    assert(revision > 0);
    const server = await f.store.server();
    assertEquals(await server.query('SELECT * FROM push_targets'), []);
    await sender.tick();
    assertEquals((await server.query('SELECT * FROM push_targets')).length, 1);
    assertEquals(await f.pending(), []);
    await revokeToken(f.tenant, f.token);
    assert(Number((await f.pending())[0].value) > revision);
    await sender.tick();
    assertEquals(await server.query('SELECT * FROM push_targets'), []);
    assertEquals(await f.pending(), []);
  } finally {
    await sender.stop();
    await f.close();
  }
});

Deno.test('tenant projection: worker never opens an idle tenant', async () => {
  const f = await fixture();
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: () => Promise.resolve([]),
  });
  const original = f.store.tenant.bind(f.store);
  let visits = 0;
  f.store.tenant = (...args: Parameters<Store['tenant']>) => {
    visits++;
    return original(...args);
  };
  try {
    await sender.tick();
    await sender.tick();
    assertEquals(
      visits,
      0,
      'no tenant discovery, open or projection for idle scans',
    );
  } finally {
    f.store.tenant = original;
    await sender.stop();
    await f.close();
  }
});

Deno.test('tenant projection: mutation rollback leaves no marker and startup recovers committed pending work', async () => {
  const f = await fixture();
  try {
    setTenantProjector(undefined);
    await assertRejects(
      () =>
        f.tenant.tx(async (tx) => {
          await tx.devices.rename('B', 'bob', 'rolled back');
          throw new Error('rollback');
        }),
      Error,
      'rollback',
    );
    assertEquals(await f.pending(), []);
    await f.register();
    assertEquals((await f.pending()).length, 1);
    await f.reopen();
    assertEquals(await f.pending(), []);
    assertEquals(
      (await (await f.store.server()).query('SELECT * FROM push_targets'))
        .length,
      1,
    );
    assertEquals(
      (await f.tenant.tx((tx) => tx.devices.byId('B', 'bob')))!.display_name,
      null,
    );
  } finally {
    await f.close();
  }
});

Deno.test('tenant projection: failed recovery retains pending work and an older acknowledgment cannot erase a newer commit', async () => {
  const f = await fixture();
  const sender = await startPushSender({
    store: f.store,
    tenant: f.tenant,
    automatic: false,
    send: () => Promise.resolve([]),
  });
  const original = f.store.tenant.bind(f.store);
  try {
    setTenantProjector(undefined);
    await f.register();
    f.store.tenant = () => Promise.reject(new Error('projection unavailable'));
    await assertRejects(() => sender.tick(), Error, 'projection unavailable');
    f.store.tenant = original;
    const first = Number((await f.pending())[0].value);
    let interleaved = false;
    const wrapped = new WeakSet<object>();
    f.store.tenant = async (...args: Parameters<Store['tenant']>) => {
      const db = await original(...args);
      if (!wrapped.has(db)) {
        wrapped.add(db);
        const tx = db.tx.bind(db);
        // Completion now records durable progress and clears pending debt in
        // one transaction. Interleave before that transaction, not inside it.
        db.tx = async (fn, options) => {
          if (!interleaved) {
            interleaved = true;
            await f.register();
          }
          return await tx(fn, options);
        };
      }
      return db;
    };
    await sender.tick();
    assert(interleaved);
    assert(Number((await f.pending())[0].value) > first);
    const server = await f.store.server();
    const old = (await server.query('SELECT incarnation FROM push_targets'))[0]
      .incarnation;
    f.store.tenant = original;
    await sender.tick();
    assertEquals(await f.pending(), []);
    assert(
      (await server.query('SELECT incarnation FROM push_targets'))[0]
        .incarnation !== old,
    );
  } finally {
    f.store.tenant = original;
    await sender.stop();
    await f.close();
  }
});
