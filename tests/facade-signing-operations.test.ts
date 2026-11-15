import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import {
  captureSigningOperations,
  importSigningOperation,
  type SigningOperation,
} from '#engine/tenant/signing-operations.ts';
import { clearSigningKeys } from '#engine/tenant/cross-signing.ts';
import { deactivateUserRows } from '#engine/tenant/users.ts';
import { createHash } from 'node:crypto';
import { serverSchema } from '#engine/server/schema.ts';
import { fanoutSigningChange } from '#engine/server/device-federation.ts';
import { publicSigningPayload } from '#engine/e2ee-signing.ts';
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';

const user = '@alice:logical.test';
async function keys() {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const body: Record<string, unknown> = {
    master_key: {
      user_id: user,
      usage: ['master'],
      keys: { ['ed25519:' + pub]: pub },
    },
  };
  for (const usage of ['self_signing', 'user_signing']) {
    const subordinate = await generateSigningKeypair() as CryptoKeyPair;
    const key = b64encodeStd(await exportPublicKeyRaw(subordinate.publicKey));
    const json = {
      user_id: user,
      usage: [usage],
      keys: { ['ed25519:' + key]: key },
    };
    await signJson(json, user, 'ed25519:' + pub, pair.privateKey);
    body[usage + '_key'] = json;
  }
  return signingUpload(body, user, config().e2ee);
}
async function fixture(node: 'home' | 'edge') {
  const dir = await Deno.makeTempDir({ prefix: 'facade-signing-owner-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = { tenant: tenantSchema, server: serverSchema };
  let store = await openStore(options, { schemas });
  let tenant = await openTenant(store, 'logical.test', { create: true });
  await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
  let db = await store.tenant('logical.test');
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
    get tenant() {
      return tenant;
    },
    get db() {
      return db;
    },
    async reopen() {
      await store.close();
      store = await openStore(options, { schemas });
      tenant = await openTenant(store, 'logical.test');
      db = await store.tenant('logical.test');
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
    server: () => store.server(),
  };
}

Deno.test('F2 signing identity mutation commits original home intent with the complete public identity', async () => {
  const home = await fixture('home');
  try {
    const first = await keys();
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, first, '{}', false)
    );
    const changes = await home.db.query('SELECT payload FROM e2ee_changes');
    const operation =
      JSON.parse(String(changes.at(-1)!.payload)).signingOperation;
    assert(
      operation,
      'home signing mutation must retain semantic export intent',
    );
    assertEquals(operation.source, 'home');
    assertEquals(operation.incarnation, 'home-store');
    assertEquals(operation.localpart, 'alice');
    assertEquals(operation.keys.map((key: { usage: string }) => key.usage), [
      'master',
      'self_signing',
      'user_signing',
    ]);
    await home.reopen();
    assertEquals(
      await home.db.query('SELECT payload FROM e2ee_changes'),
      changes,
    );
    await assertRejects(
      () =>
        home.tenant.tx(async (tx) => {
          await tx.crossSigning.upload(
            'alice',
            user,
            await keys(),
            canonicalJson(first),
            true,
          );
          throw new Error('abort signing');
        }),
      Error,
      'abort signing',
    );
    assertEquals(
      await home.db.query('SELECT payload FROM e2ee_changes'),
      changes,
    );
    assertEquals(
      await home.tenant.tx((tx) => tx.crossSigning.state('alice')),
      first,
    );
  } finally {
    await home.close();
  }
});

const expected = {
  source: 'home',
  incarnation: 'home-store',
  localpart: 'alice',
};
function rehash(operation: SigningOperation): SigningOperation {
  const { payloadHash: _hash, ...body } = operation;
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

Deno.test('F2 signing identity imports original home revisions in any order, without source echo or private-view leakage', async () => {
  const home = await fixture('home'), edge = await fixture('edge');
  try {
    const first = await keys(), second = await keys();
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, first, '{}', false)
    );
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, second, canonicalJson(first), true)
    );
    const operations = await home.db.tx((conn) =>
      captureSigningOperations(conn, 'alice')
    );
    assertEquals(operations.length, 2);
    for (const operation of [...operations].reverse()) {
      await edge.db.tx((conn) =>
        importSigningOperation(conn, operation, expected)
      );
    }
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.state('alice')),
      second,
    );
    assertEquals(
      await edge.db.query('SELECT * FROM cross_signing_keys ORDER BY usage'),
      await home.db.query('SELECT * FROM cross_signing_keys ORDER BY usage'),
    );
    const changes = await edge.db.query('SELECT * FROM e2ee_changes');
    for (const operation of operations) {
      await edge.db.tx((conn) =>
        importSigningOperation(conn, operation, expected)
      );
    }
    assertEquals(await edge.db.query('SELECT * FROM e2ee_changes'), changes);
    assertEquals(
      await edge.db.tx((conn) => captureSigningOperations(conn, 'alice')),
      [],
    );
    const own = await edge.tenant.tx((tx) =>
      tx.crossSigning.views('alice', user, user)
    );
    const other = await edge.tenant.tx((tx) =>
      tx.crossSigning.views('alice', user, '@bob:logical.test')
    );
    assert(own.user_signing_keys);
    assertEquals(other.user_signing_keys, undefined);
    assertEquals(await edge.db.query('SELECT * FROM device_keys'), []);
    assertEquals(await edge.db.query('SELECT * FROM one_time_keys'), []);
    await edge.reopen();
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.views('alice', user, user)),
      own,
    );
    const source = JSON.parse(
      String(
        (await home.db.query(
          'SELECT payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
        ))[0].payload,
      ),
    );
    const server = await edge.server();
    await server.tx((conn) => fanoutSigningChange(conn, user, 1, source));
    const [published] = await server.query(
      'SELECT payload FROM public_signing_keys WHERE subject=?',
      [user],
    );
    assertEquals(
      JSON.parse(String(published.payload)),
      publicSigningPayload(source),
    );
    assert(!String(published.payload).includes(second.user_signing!.public));
    assert(!String(published.payload).includes('signingOperation'));
  } finally {
    await home.close();
    await edge.close();
  }
});

Deno.test('F2 signing identity refuses forged source, account, keys and collisions before retaining any mutation', async () => {
  const home = await fixture('home'), edge = await fixture('edge');
  try {
    const first = await keys();
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, first, '{}', false)
    );
    const [operation] = await home.db.tx((conn) =>
      captureSigningOperations(conn, 'alice')
    );
    for (
      const invalid of [
        { ...operation, source: 'edge' },
        rehash({ ...operation, incarnation: 'old-store' }),
        rehash({ ...operation, localpart: 'bob' }),
        rehash({ ...operation, keys: operation.keys.slice(1) }),
        rehash({ ...operation, keys: [{ ...operation.keys[0], revision: 0 }] }),
        rehash({ ...operation, keys: [operation.keys[0], operation.keys[0]] }),
        rehash({
          ...operation,
          keys: [{
            ...operation.keys[0],
            key: { ...operation.keys[0].key, user_id: '@mallory:logical.test' },
          }],
        }),
        rehash({
          ...operation,
          keys: operation.keys.map((item) =>
            item.usage === 'self_signing'
              ? { ...item, key: { ...item.key, signatures: {} } }
              : item
          ),
        }),
        { ...operation, payloadHash: '0'.repeat(64) },
        { ...operation, private_key: 'forbidden' },
      ]
    ) {
      await assertRejects(() =>
        edge.db.tx((conn) => importSigningOperation(conn, invalid, expected))
      );
    }
    assertEquals(await edge.db.query('SELECT * FROM signing_operations'), []);
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.state('alice')),
      {},
    );
    await assertRejects(
      () =>
        edge.db.tx(async (conn) => {
          await importSigningOperation(conn, operation, expected);
          throw new Error('abort import');
        }),
      Error,
      'abort import',
    );
    assertEquals(await edge.db.query('SELECT * FROM signing_operations'), []);
    await edge.db.tx((conn) =>
      importSigningOperation(conn, operation, expected)
    );
    await assertRejects(
      () =>
        edge.db.tx((conn) =>
          importSigningOperation(
            conn,
            rehash({ ...operation, keys: [] }),
            expected,
          )
        ),
      Error,
      'signing operation collision',
    );
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.state('alice')),
      first,
    );
  } finally {
    await home.close();
    await edge.close();
  }
});

Deno.test('F2 signing identity clear and terminal deactivation cannot be undone by delayed home revisions', async () => {
  const home = await fixture('home'), edge = await fixture('edge');
  try {
    const first = await keys();
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, first, '{}', false)
    );
    await home.db.tx((conn) =>
      clearSigningKeys(conn, 'alice', user, config().federation.bulkmaxbytes)
    );
    const operations = await home.db.tx((conn) =>
      captureSigningOperations(conn, 'alice')
    );
    assertEquals(operations.length, 2);
    assertEquals(operations[1].keys, []);
    for (const operation of [...operations].reverse()) {
      await edge.db.tx((conn) =>
        importSigningOperation(conn, operation, expected)
      );
    }
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.state('alice')),
      {},
    );
    await edge.db.tx((conn) =>
      deactivateUserRows(conn, 'logical.test', 'alice')
    );
    const latest = await keys();
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, latest, '{}', false)
    );
    const current = (await home.db.tx((conn) =>
      captureSigningOperations(conn, 'alice')
    )).at(-1)!;
    await edge.db.tx((conn) =>
      importSigningOperation(conn, current, expected)
    );
    await edge.reopen();
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.state('alice')),
      {},
    );
    assertEquals(
      await edge.tenant.tx((tx) => tx.crossSigning.views('alice', user, user)),
      {},
    );
    assertEquals(
      (await edge.db.query('SELECT * FROM signing_operations')).length,
      3,
    );
  } finally {
    await home.close();
    await edge.close();
  }
});

Deno.test('F2 signing identity upgrades pre-enrollment keys and pins repeatable complete or empty bootstrap', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'signing-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(30) },
  });
  try {
    let tenant = await openTenant(store, 'logical.test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.users.insert('empty', 'Empty');
    });
    const first = await keys();
    await tenant.tx((tx) =>
      tx.crossSigning.upload('alice', user, first, '{}', false)
    );
    const identity = tenant.publicB64;
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'logical.test');
    assertEquals(tenant.publicB64, identity);
    const db = await store.tenant('logical.test');
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'home',
        incarnation: 'home-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    const capture = () =>
      db.tx((conn) => captureSigningOperations(conn, 'alice'));
    const captured = await capture();
    assertEquals(captured.length, 1);
    assertEquals(captured[0].keys.length, 3);
    assertEquals(await capture(), captured);
    const empty = await db.tx((conn) =>
      captureSigningOperations(conn, 'empty')
    );
    assertEquals(empty.length, 1);
    assertEquals(empty[0].keys, []);
    const schema = await db.query(
      "SELECT name,sql FROM sqlite_master WHERE name LIKE 'signing_operations%' ORDER BY name",
    );
    await openTenant(store, 'fresh.test', { create: true });
    assertEquals(
      await (await store.tenant('fresh.test')).query(
        "SELECT name,sql FROM sqlite_master WHERE name LIKE 'signing_operations%' ORDER BY name",
      ),
      schema,
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const reopened = await store.tenant('logical.test');
    assertEquals(
      await reopened.tx((conn) => captureSigningOperations(conn, 'alice')),
      captured,
    );
    assertEquals(
      await reopened.tx((conn) => captureSigningOperations(conn, 'empty')),
      empty,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
