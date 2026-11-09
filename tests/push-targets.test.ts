import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  issueToken,
  revokeToken,
} from '#engine/tenant/auth.ts';
import { listPushers, setPusher } from '#engine/tenant/pushers.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { TENANT_V12 } from '#tests/fixtures/tenant-v12.ts';

const input = (append = false) => ({
  app_id: 'app',
  pushkey: 'key',
  kind: 'http',
  app_display_name: 'App',
  device_display_name: 'Device',
  lang: 'en',
  data: {
    url: 'https://gateway.test/_matrix/push/v1/notify',
    format: 'event_id_only',
    custom: { value: 1 },
  },
  append,
});

async function fixture(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema, server: serverSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('push targets: append identity, incarnation replacement and durable token cleanup', async () => {
  await fixture(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.users.insert('bob', 'Bob');
    });
    const alice = await issueToken(tenant, 'alice', 'A');
    const bob = await issueToken(tenant, 'bob', 'B');
    await setPusher(tenant, 'alice', alice, input());
    await setPusher(tenant, 'bob', bob, input(true));
    assertEquals((await listPushers(tenant, 'alice')).length, 1);
    await setPusher(tenant, 'bob', bob, input());
    assertEquals(await listPushers(tenant, 'alice'), []);
    await setPusher(tenant, 'alice', alice, {
      ...input(true),
      app_id: 'other',
    });
    await projectTenant(store, 'test');
    const db = await store.server();
    const targets = () =>
      db.query('SELECT * FROM push_targets ORDER BY user,app_id');
    const rows = await targets();
    assertEquals(rows.length, 2);
    const old = String(rows.find((r) => r.user === '@bob:test')!.incarnation);
    await setPusher(tenant, 'bob', bob, input());
    await projectTenant(store, 'test');
    const next = (await targets()).find((r) => r.user === '@bob:test')!;
    assert(String(next.incarnation) !== old);
    // Refresh keeps the target incarnation and moves token ownership.
    const refresh = await issueRefreshToken(tenant, 'bob', 'B', bob);
    const rotated = await consumeRefreshToken(tenant, refresh);
    await projectTenant(store, 'test');
    assertEquals(
      (await targets()).find((r) => r.user === '@bob:test')!.incarnation,
      next.incarnation,
    );
    await revokeToken(tenant, bob);
    assertEquals((await listPushers(tenant, 'bob')).length, 1);
    await revokeToken(tenant, rotated.accessToken);
    // Tenant commit is authoritative even if its post-commit projection was missed.
    assertEquals((await targets()).length, 2);
    await projectTenant(store, 'test');
    assertEquals((await targets()).map((r) => r.user), ['@alice:test']);
    await projectTenant(store, 'test');
    assertEquals((await targets()).length, 1);
  });
});

Deno.test('push targets: durable rejected incarnation never removes a replacement', async () => {
  await fixture(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const token = await issueToken(tenant, 'bob', 'B');
    await setPusher(tenant, 'bob', token, input());
    await projectTenant(store, 'test');
    const db = await store.server();
    const old = (await db.query('SELECT * FROM push_targets'))[0];
    await db.execute(
      'INSERT INTO push_rejections(tenant,user,app_id,pushkey,incarnation) VALUES(?,?,?,?,?)',
      ['test', '@bob:test', 'app', 'key', old.incarnation],
    );
    await setPusher(tenant, 'bob', token, input());
    await projectTenant(store, 'test');
    assertEquals((await listPushers(tenant, 'bob')).length, 1);
    const current = (await db.query('SELECT * FROM push_targets'))[0];
    assert(current.incarnation !== old.incarnation);
    await db.execute(
      'INSERT INTO push_rejections(tenant,user,app_id,pushkey,incarnation) VALUES(?,?,?,?,?)',
      ['test', '@bob:test', 'app', 'key', current.incarnation],
    );
    await projectTenant(store, 'test');
    assertEquals(await listPushers(tenant, 'bob'), []);
    assertEquals(await db.query('SELECT * FROM push_targets'), []);
    assertEquals(await db.query('SELECT * FROM push_rejections'), []);
  });
});

Deno.test('push targets: validation rejects unsupported email, unsafe URLs, formats and stale tokens without network probes', async () => {
  await fixture(async (store) => {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const token = await issueToken(tenant, 'bob', 'B');
    for (
      const bad of [
        { ...input(), kind: 'email' },
        { ...input(), data: [] },
        { ...input(), app_id: 'a'.repeat(65) },
        { ...input(), pushkey: 'x'.repeat(513) },
        ...[
          'http://gateway.test/_matrix/push/v1/notify',
          'https://u:p@gateway.test/_matrix/push/v1/notify',
          'https://gateway.test',
          'https://gateway.test/wrong',
          'https://gateway.test/_matrix/push/v1/notify#frag',
        ].map((url) => ({ ...input(), data: { url } })),
        { ...input(), data: { ...input().data, format: 'unknown' } },
      ]
    ) {
      await assertRejects(
        () => setPusher(tenant, 'bob', token, bad),
        MatrixError,
      );
    }
    await setPusher(tenant, 'bob', token, input());
    await revokeToken(tenant, token);
    await assertRejects(
      () => setPusher(tenant, 'bob', token, input()),
      MatrixError,
    );
    assertEquals(await listPushers(tenant, 'bob'), []);
  });
});

Deno.test('push targets: supported v13 upgrade preserves registration/token/identity and projects once without history replay', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: {
      tenant: {
        version: 13,
        apply: async (db) => {
          await db.exec(TENANT_V12);
          await db.exec(
            "CREATE TABLE account_changes(pos INTEGER PRIMARY KEY NOT NULL,localpart TEXT NOT NULL,kind TEXT NOT NULL); INSERT INTO counters VALUES('account_changes',0)",
          );
        },
      },
      server: serverSchema,
    },
  });
  try {
    let tenant = await openTenant(store, 'test', { create: true });
    const key = tenant.publicB64;
    await tenant.tx((tx) => tx.users.insert('bob', 'Bob'));
    const token = await issueToken(tenant, 'bob', 'B');
    const db = await store.tenant('test');
    const hash = (await db.query('SELECT token FROM access_tokens'))[0].token;
    await db.execute('INSERT INTO pushers VALUES(?,?,?,?,?,?,?,?,?,?)', [
      'bob',
      'app',
      'key',
      'http',
      'App',
      'Device',
      null,
      'en',
      JSON.stringify(input().data),
      hash,
    ]);
    await store.close();
    store = await openStore(options, {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    tenant = await openTenant(store, 'test');
    assertEquals(tenant.publicB64, key);
    await projectTenant(store, 'test');
    const server = await store.server();
    const targets = await server.query('SELECT * FROM push_targets');
    assertEquals(targets.length, 1);
    assertEquals(targets[0].registered_seq, 0);
    assertEquals(targets[0].state, 'active');
    assertEquals(await server.query('SELECT * FROM notifications'), []);
    await projectTenant(store, 'test');
    assertEquals(await server.query('SELECT * FROM push_targets'), targets);
    await revokeToken(tenant, token);
    await projectTenant(store, 'test');
    assertEquals(await server.query('SELECT * FROM push_targets'), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
