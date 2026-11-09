import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { issueToken, revokeToken } from '#engine/tenant/auth.ts';
import { setPusher } from '#engine/tenant/pushers.ts';
import { setTenantProjector } from '#engine/tenant/hooks.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/index.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { startPushSender } from '#engine/push/sender.ts';

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
    reopen: async () => {
      await store.close();
      store = await openStore(options, { schemas });
      tenant = await openTenant(store, 'test');
    },
    close: async () => {
      setTenantProjector(projectTenant);
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

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
    f.store.tenant = async (...args: Parameters<Store['tenant']>) => {
      const db = await original(...args);
      const execute = db.execute;
      db.execute = async (sql, values) => {
        if (!interleaved && sql.startsWith('DELETE FROM counters')) {
          interleaved = true;
          await f.register();
        }
        return execute(sql, values);
      };
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
