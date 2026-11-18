import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { registerOperations } from '#engine/facade/registers.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-backup-' });
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  const tenants: Awaited<ReturnType<typeof openTenant>>[] = [];
  for (const node of ['home', 'edge']) {
    const store = await openStore({
      dir: dir + '/' + node,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
    stores.push(store);
    const tenant = await openTenant(store, 'logical.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await (await store.tenant(tenant.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    tenants.push(tenant);
  }
  return {
    home: tenants[0],
    edge: tenants[1],
    stores,
    operations: (node = 0, version = '1') =>
      stores[node].tenant('logical.test')
        .then((db) =>
          db.tx((conn) =>
            registerOperations(
              conn,
              JSON.stringify(['backup', 'alice', version]),
            )
          )
        ),
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const metadata = {
  algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
  auth_data: { public_key: 'opaque' },
};
const session = {
  first_message_index: 0,
  forwarded_count: 1,
  is_verified: true,
  session_data: { ciphertext: 'encrypted', mac: 'mac', ephemeral: 'key' },
};

Deno.test('facade backup: malformed private revisions have payload-free diagnostics', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    const operation = (await f.operations())[0];
    for (
      const invalid of [
        { ...operation, payload: '{"ciphertext":"PRIVATE_BACKUP_MARKER",' },
        { ...operation, semanticKey: '["backup","PRIVATE_BACKUP_MARKER",' },
      ]
    ) {
      const error = await assertRejects(
        () => f.edge.tx((tx) => tx.keyBackup.import(invalid)),
        Error,
      );
      assertEquals(error.message, 'invalid backup revision');
    }
    assertEquals(await f.operations(1), []);
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: each accepted home revision retains its exact export fact', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    assertEquals(
      (await f.operations()).length,
      1,
      'backup creation ACK has no durable semantic fact',
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's', session)
    );
    const facts = await f.operations();
    assertEquals(facts.length, 2);
    assertEquals(facts[1].source, 'home');
    assertEquals(JSON.parse(facts[1].payload).etag, '1');
    assertEquals(
      JSON.parse(facts[1].payload).rooms['!r:logical.test'].sessions.s,
      session,
    );
    await f.home.tx((tx) => tx.keyBackup.version('alice', 'delete', '1'));
    assertEquals(
      JSON.parse((await f.operations()).at(-1)!.payload).deleted,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: tenant owner refuses every facade mutation before any row changes', async () => {
  const f = await fixture();
  try {
    for (const action of ['post', 'put', 'delete'] as const) {
      const error = await assertRejects(
        () =>
          f.edge.tx((tx) =>
            tx.keyBackup.version('alice', action, '1', metadata)
          ),
        MatrixError,
      );
      assertEquals(error.status, 503);
      assertEquals(error.responseBody(), {
        errcode: 'M_UNAVAILABLE',
        error: 'operation requires home ingress',
      });
    }
    for (const action of ['put', 'delete'] as const) {
      const error = await assertRejects(
        () =>
          f.edge.tx((tx) =>
            tx.keyBackup.keys(
              'alice',
              action,
              '1',
              '!r:logical.test',
              's',
              session,
            )
          ),
        MatrixError,
      );
      assertEquals(error.status, 503);
    }
    assertEquals(await f.operations(1), []);
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: terminal account cannot recreate a private backup', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) => tx.users.markDeactivated('alice'));
    await assertRejects(
      () =>
        f.home.tx((tx) =>
          tx.keyBackup.version('alice', 'post', undefined, metadata)
        ),
      MatrixError,
    );
    assertEquals(await f.operations(), []);
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: authentic complete home revisions replay out of order without quality or etag merging', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's', session)
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'delete', '1', '!r:logical.test', 's')
    );
    const facts = await f.operations();
    for (const fact of [...facts].reverse()) {
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
      { ...metadata, version: '1', etag: '2', count: 0 },
    );
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
      { rooms: {} },
    );
    for (const fact of facts) {
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    assertEquals((await f.operations(1)).length, facts.length);
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'put', '1', {
        ...metadata,
        auth_data: { changed: 0.5 },
      })
    );
    const authUpdate = (await f.operations()).at(-1)!;
    await f.edge.tx((tx) => tx.keyBackup.import(authUpdate));
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.version('alice', 'get')),
      {
        ...metadata,
        auth_data: { changed: 0.5 },
        version: '1',
        etag: '2',
        count: 0,
      },
    );
    await f.home.tx((tx) => tx.keyBackup.version('alice', 'delete', '1'));
    const deletion = (await f.operations()).at(-1)!;
    await f.edge.tx((tx) => tx.keyBackup.import(deletion));
    const absent = await assertRejects(
      () => f.edge.tx((tx) => tx.keyBackup.version('alice', 'get')),
      MatrixError,
    );
    assertEquals(absent.status, 404);
    // A late older ciphertext revision cannot undo the home deletion.
    await f.edge.tx((tx) => tx.keyBackup.import(facts[1]));
    await assertRejects(
      () => f.edge.tx((tx) => tx.keyBackup.version('alice', 'get')),
      MatrixError,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: export failure rolls back ciphertext, metadata and derived accounting together', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    const db = await f.stores[0].tenant('logical.test');
    await db.exec(
      "CREATE TRIGGER fail_backup_export BEFORE INSERT ON domain_operations BEGIN SELECT RAISE(ABORT,'backup export failed'); END",
    );
    await assertRejects(() =>
      f.home.tx((tx) =>
        tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's', session)
      )
    );
    await db.exec('DROP TRIGGER fail_backup_export');
    assertEquals(
      await f.home.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
      { rooms: {} },
    );
    assertEquals(
      await f.home.tx((tx) => tx.keyBackup.version('alice', 'get')),
      { ...metadata, version: '1', etag: '0', count: 0 },
    );
    assertEquals((await f.operations()).length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: no-op uploads do not add revisions and terminal replicas retain evidence without ciphertext', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's', session)
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's', {
        ...session,
        is_verified: false,
      })
    );
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'put', '1', metadata)
    );
    const facts = await f.operations();
    assertEquals(facts.length, 2);
    await f.edge.tx(async (tx) => {
      await tx.users.markDeactivated('alice');
      await tx.keyBackup.clear('alice');
    });
    for (const fact of facts) {
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    assertEquals((await f.operations(1)).length, 2);
    const db = await f.stores[1].tenant('logical.test');
    assertEquals(await db.query('SELECT payload FROM backup_sessions'), []);
    await assertRejects(
      () => f.edge.tx((tx) => tx.keyBackup.version('alice', 'get')),
      MatrixError,
    );
    const forged = structuredClone(facts[0]);
    forged.source = 'edge';
    forged.incarnation = 'edge-store';
    await assertRejects(
      () => f.edge.tx((tx) => tx.keyBackup.import(forged)),
      Error,
      'invalid backup revision',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade backup: failed passive import rolls back its fact and all version accounting', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's', session)
    );
    const facts = await f.operations();
    await f.edge.tx((tx) => tx.keyBackup.import(facts[0]));
    const db = await f.stores[1].tenant('logical.test');
    await db.exec(
      "CREATE TRIGGER fail_backup_import BEFORE INSERT ON backup_sessions BEGIN SELECT RAISE(ABORT,'backup import failed'); END",
    );
    await assertRejects(() => f.edge.tx((tx) => tx.keyBackup.import(facts[1])));
    await db.exec('DROP TRIGGER fail_backup_import');
    assertEquals((await f.operations(1)).length, 1);
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.version('alice', 'get')),
      { ...metadata, version: '1', count: 0, etag: '0' },
    );
    await f.edge.tx((tx) => tx.keyBackup.import(facts[1]));
    const restored = await f.edge.tx((tx) =>
      tx.keyBackup.keys('alice', 'get', '1')
    );
    const [totals] = await db.query(
      'SELECT session_count,restore_bytes FROM backup_versions WHERE localpart=? AND version_no=1',
      ['alice'],
    );
    assertEquals(totals, {
      session_count: 1,
      restore_bytes: new TextEncoder().encode(JSON.stringify(restored)).length,
    });
  } finally {
    await f.close();
  }
});
