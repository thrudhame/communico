import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { Turso } from '#engine/store/ffi.ts';
import { captureBackupOperations } from '#engine/tenant/key-backup.ts';

async function fixture(enrolled = true) {
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
    if (enrolled) {
      await (await store.tenant(tenant.serverName)).tx((conn) =>
        activateTenantAuthority(conn, {
          node,
          incarnation: node + '-store',
          homeIncarnation: 'home-store',
          edgeNode: 'edge',
          edgeIncarnation: 'edge-store',
        })
      );
    }
    tenants.push(tenant);
  }
  return {
    home: tenants[0],
    edge: tenants[1],
    stores,
    operations: (node = 0, version = '1') =>
      tenants[node].tx(async (tx) =>
        (await tx.keyBackup.operations('alice'))
          .filter((op) => JSON.parse(op.semanticKey)[2] === version)
          .sort((a, b) =>
            a.sequence - b.sequence ||
            JSON.parse(a.semanticKey).length - JSON.parse(b.semanticKey).length
          )
      ),
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade backup complete revision: bootstrap waits for every exact session dependency', async () => {
  const f = await fixture(false);
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', undefined, {
        sessions: { a: session, b: session },
      })
    );
    for (const [i, node] of ['home', 'edge'].entries()) {
      await (await f.stores[i].tenant('logical.test')).tx((conn) =>
        activateTenantAuthority(conn, {
          node,
          incarnation: node + '-store',
          homeIncarnation: 'home-store',
          edgeNode: 'edge',
          edgeIncarnation: 'edge-store',
        })
      );
    }
    const facts = await (await f.stores[0].tenant('logical.test')).tx((conn) =>
      captureBackupOperations(conn, 'alice')
    );
    const revision = facts.find((op) =>
      JSON.parse(op.semanticKey).length === 3
    )!;
    const sessions = facts.filter((op) =>
      JSON.parse(op.semanticKey).length === 5
    );
    await f.edge.tx((tx) => tx.keyBackup.import(revision));
    for (const fact of sessions) {
      for (
        const read of [
          () => f.edge.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
          () => f.edge.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
        ]
      ) {
        const error = await assertRejects(read, MatrixError);
        assertEquals(error.status, 503);
      }
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
      await f.home.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
    );
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
      await f.home.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
    );
  } finally {
    await f.close();
  }
});

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

for (const order of ['metadata-first', 'sessions-first'] as const) {
  Deno.test(`facade backup complete revision: ${order} cuts keep matching etag and keys`, async () => {
    const f = await fixture();
    try {
      const room = '!r:logical.test';
      await f.home.tx((tx) =>
        tx.keyBackup.version('alice', 'post', undefined, metadata)
      );
      for (const fact of await f.operations()) {
        await f.edge.tx((tx) => tx.keyBackup.import(fact));
      }
      const read = (tenant: typeof f.home) =>
        tenant.tx(async (tx) => ({
          metadata: await tx.keyBackup.version('alice', 'get', '1'),
          keys: await tx.keyBackup.keys('alice', 'get', '1'),
        }));
      for (const action of ['insert', 'replace', 'delete'] as const) {
        const previous = await read(f.edge);
        const before = new Set(
          (await f.operations()).map((op) => op.operationId),
        );
        await f.home.tx((tx) =>
          action === 'delete'
            ? tx.keyBackup.keys('alice', 'delete', '1', room, 's')
            : tx.keyBackup.keys('alice', 'put', '1', room, 's', {
              ...session,
              forwarded_count: action === 'replace' ? 0 : 1,
            })
        );
        const delta = (await f.operations()).filter((op) =>
          !before.has(op.operationId)
        );
        const facts = delta.sort((a, b) =>
          order === 'metadata-first'
            ? a.semanticKey.length - b.semanticKey.length
            : b.semanticKey.length - a.semanticKey.length
        );
        assertEquals(facts.length, 2);
        await f.edge.tx((tx) => tx.keyBackup.import(facts[0]));
        assertEquals(
          await read(f.edge),
          previous,
          `${action} exposed a partial revision`,
        );
        await f.edge.tx((tx) => tx.keyBackup.import(facts[1]));
        assertEquals(await read(f.edge), await read(f.home));
        await f.edge.tx((tx) => tx.keyBackup.import(facts[0]));
        assertEquals(await read(f.edge), await read(f.home));
      }
    } finally {
      await f.close();
    }
  });
}

Deno.test('facade backup delta: one-session upload work does not grow with backup size', async () => {
  const samples: { size: number; rows: number; facts: number }[] = [];
  for (const size of [2, 24]) {
    const f = await fixture();
    try {
      await f.home.tx((tx) =>
        tx.keyBackup.version('alice', 'post', undefined, metadata)
      );
      await f.home.tx((tx) =>
        tx.keyBackup.keys('alice', 'put', '1', undefined, undefined, {
          rooms: {
            '!r:logical.test': {
              sessions: Object.fromEntries(
                Array.from({ length: size }, (_, i) => ['s' + i, session]),
              ),
            },
          },
        })
      );
      const before = await f.home.tx((tx) => tx.keyBackup.operations('alice'));
      const original = Turso.prototype.query;
      let rows = 0;
      Turso.prototype.query = async function (...args) {
        const result = await original.apply(this, args);
        rows += result.length;
        return result;
      };
      try {
        await f.home.tx((tx) =>
          tx.keyBackup.keys('alice', 'put', '1', '!r:logical.test', 's0', {
            ...session,
            forwarded_count: 0,
          })
        );
      } finally {
        Turso.prototype.query = original;
      }
      const after = await f.home.tx((tx) => tx.keyBackup.operations('alice'));
      samples.push({ size, rows, facts: after.length - before.length });
    } finally {
      await f.close();
    }
  }
  assertEquals(samples.map((sample) => sample.facts), [2, 2]);
  assertEquals(samples[0].rows, samples[1].rows);
});

Deno.test('facade backup delta: home quality, exact counters and deletes converge without losing other sessions', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    const room = '!r:logical.test';
    const put = (id: string, data: typeof session) =>
      f.home.tx((tx) => tx.keyBackup.keys('alice', 'put', '1', room, id, data));
    const sync = async () => {
      for (const fact of [...await f.operations()].reverse()) {
        await f.edge.tx((tx) => tx.keyBackup.import(fact));
      }
      for (
        const read of [
          (t: typeof f.home) =>
            t.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
          (t: typeof f.home) =>
            t.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
        ]
      ) assertEquals(await read(f.edge), await read(f.home));
    };
    let expected = {
      ...session,
      is_verified: false,
      first_message_index: 20,
      forwarded_count: 20,
    };
    await put('s', expected);
    await put('untouched', session);
    let etag = 2;
    for (
      const [candidate, accepted] of [
        [{ ...session, first_message_index: 99, forwarded_count: 99 }, true],
        [{ ...session, is_verified: false }, false],
        [{ ...session, first_message_index: 10, forwarded_count: 99 }, true],
        [{ ...session, first_message_index: 11, forwarded_count: 0 }, false],
        [{ ...session, first_message_index: 10, forwarded_count: 1 }, true],
        [{
          ...session,
          first_message_index: 10,
          forwarded_count: 1,
          session_data: {
            ciphertext: 'equal-quality',
            mac: 'mac',
            ephemeral: 'key',
          },
        }, false],
      ] as const
    ) {
      const result = await put('s', candidate);
      if (accepted) {
        expected = candidate;
        etag++;
      }
      assertEquals(result, { count: 2, etag: String(etag) });
      assertEquals(
        await f.home.tx((tx) =>
          tx.keyBackup.keys('alice', 'get', '1', room, 's')
        ),
        expected,
      );
      await sync();
    }
    await f.home.tx((tx) =>
      tx.keyBackup.keys('alice', 'delete', '1', room, 's')
    );
    await sync();
    assertEquals(
      await f.edge.tx((tx) =>
        tx.keyBackup.keys('alice', 'get', '1', room, 'untouched')
      ),
      session,
    );
    await f.home.tx((tx) => tx.keyBackup.keys('alice', 'delete', '1', room));
    await sync();
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
      { rooms: {} },
    );
    await put('recreated', session);
    await sync();
    const beforeDeletion = await f.operations();
    await f.home.tx((tx) => tx.keyBackup.version('alice', 'delete', '1'));
    for (const fact of [...await f.operations()].reverse()) {
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    for (const fact of beforeDeletion) {
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    await assertRejects(
      () => f.edge.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
      MatrixError,
    );
    await assertRejects(
      () => f.home.tx((tx) => tx.keyBackup.version('alice', 'get', '1')),
      MatrixError,
    );
    const db = await f.stores[1].tenant('logical.test');
    assertEquals(await db.query('SELECT payload FROM backup_sessions'), []);
  } finally {
    await f.close();
  }
});

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
    assertEquals(facts.length, 3);
    assertEquals(facts[1].source, 'home');
    assertEquals(JSON.parse(facts[2].payload).etag, '1');
    assertEquals(JSON.parse(facts[2].payload).count, 1);
    assertEquals(
      JSON.parse(facts[1].payload).data,
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
    assertEquals(facts.length, 3);
    await f.edge.tx(async (tx) => {
      await tx.users.markDeactivated('alice');
      await tx.keyBackup.clear('alice');
    });
    for (const fact of facts) {
      await f.edge.tx((tx) => tx.keyBackup.import(fact));
    }
    assertEquals((await f.operations(1)).length, 3);
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
    await f.edge.tx((tx) => tx.keyBackup.import(facts[1]));
    const db = await f.stores[1].tenant('logical.test');
    await db.exec(
      "CREATE TRIGGER fail_backup_import BEFORE INSERT ON backup_sessions BEGIN SELECT RAISE(ABORT,'backup import failed'); END",
    );
    await assertRejects(() => f.edge.tx((tx) => tx.keyBackup.import(facts[2])));
    await db.exec('DROP TRIGGER fail_backup_import');
    assertEquals((await f.operations(1)).length, 2);
    assertEquals(
      await f.edge.tx((tx) => tx.keyBackup.version('alice', 'get')),
      { ...metadata, version: '1', count: 0, etag: '0' },
    );
    await f.edge.tx((tx) => tx.keyBackup.import(facts[2]));
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
