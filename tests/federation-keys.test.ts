// tests/federation-keys.test.ts — remembered server keys: our document,
// cache validity, purpose (request vs event), key-is-name short-circuit,
// witnesses-first acquisition with seniority + disagreement, direct
// fallback, failure memory, one in-flight per name. Stub transport over
// a real server file (doltgres tests/federation-keys.test.ts, restored)
// — plus the notary-from-cache serving data (keydoc.ts).
import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  b32decode,
  b32encode,
  b64decode,
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';
import {
  assertFederationEnabled,
  keyDocResponse,
  notaryFromCache,
} from '#engine/federation/keydoc.ts';
import {
  type KeysDeps,
  keyStore,
  ourKeyDocument,
} from '#engine/federation/keys.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { randomSigner } from './fixtures/signer.ts';
import {
  directOnly,
  makeDoc,
  makeServer,
  notaryAnswer,
  seedServer,
} from './federation/doc-helper.ts';

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function stubDeps(over: Partial<KeysDeps>): KeysDeps {
  return {
    directGet: over.directGet !== undefined
      ? over.directGet
      : () => Promise.reject(new Error('no direct stub')),
    witnessQuery: over.witnessQuery !== undefined
      ? over.witnessQuery
      : () => Promise.reject(new Error('no witness stub')),
    listWitnesses: over.listWitnesses !== undefined
      ? over.listWitnesses
      : () => Promise.resolve([]),
  };
}

Deno.test('our key document: shape, ed25519: id, unpadded b64, self-signature', async () => {
  const { signer, publicKey } = await randomSigner('keys-own.test');
  const publicB64 = b64encodeStd(await exportPublicKeyRaw(publicKey));
  const doc = await ourKeyDocument(signer, publicB64);
  assertEquals(doc.server_name, 'keys-own.test');
  const ids = Object.keys(doc.verify_keys);
  assertEquals(ids.length, 1);
  assert(ids[0].startsWith('ed25519:'), `key id: ${ids[0]}`);
  const keyB64 = doc.verify_keys[ids[0]].key;
  assert(/^[A-Za-z0-9+/]*$/.test(keyB64), `standard alphabet: ${keyB64}`);
  assert(!keyB64.includes('='), `unpadded: ${keyB64}`);
  assert(doc.valid_until_ts > Date.now());
  assert(doc.old_verify_keys !== undefined);
  const signers = Object.keys(doc.signatures);
  assertEquals(signers, ['keys-own.test']);
  assert(await verifyJson(doc, 'keys-own.test', ids[0], publicKey));
});

Deno.test('cache: second acquire does not refetch; horizon past valid_until_ts refetches; 7-day cap', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('cache1.test');
    const doc = await makeDoc(s, { validUntilMs: Date.now() + 3600_000 });
    let directCalls = 0;
    const ks = keyStore(server, {
      deps: stubDeps({
        directGet: () => {
          directCalls++;
          return Promise.resolve(doc);
        },
      }),
    });
    await ks.acquireKeyDoc(s.name, 0);
    assertEquals(directCalls, 1);
    await ks.acquireKeyDoc(s.name, 0); // cache hit
    assertEquals(directCalls, 1);
    // horizon beyond the document's validity → refetch
    await ks.acquireKeyDoc(s.name, Date.now() + 2 * 3600_000);
    assertEquals(directCalls, 2);
  });
  await withStore(async (store) => {
    const server = await store.server();
    // 7-day cap on stored validity
    const s = await makeServer('cache2.test');
    const far = await makeDoc(s, { validUntilMs: Date.now() + 30 * 86400_000 });
    const ks = keyStore(server, { deps: directOnly(far) });
    const got = await ks.acquireKeyDoc(s.name, 0);
    const cap = Date.now() + 7 * 86400_000;
    assert(
      got.valid_until_ts <= cap,
      `valid_until_ts ${got.valid_until_ts} > cap ${cap}`,
    );
  });
});

Deno.test('purpose: a retired key never authenticates a request; events within expired_ts pass', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('purpose.test');
    const retired = await makeServer('purpose-old.test');
    const oldRaw = b64encodeStd(await exportPublicKeyRaw(retired.kp.publicKey));
    const expiredTs = Date.now() + 3600_000;
    const doc = await makeDoc(s, {
      oldVerifyKeys: { 'ed25519:old': { key: oldRaw, expired_ts: expiredTs } },
    });
    const ks = keyStore(server, { deps: directOnly(doc) });
    await ks.acquireKeyDoc(s.name, 0);
    // request auth with the retired key → refuse
    const reqResult = await ks.getVerifyKey(
      s.name,
      'ed25519:old',
      Date.now(),
      'request',
    )
      .then(() => 'ok')
      .catch(() => 'refused');
    assertEquals(reqResult, 'refused');
    // event signed before expiry → the retired key verifies it
    const ev = await ks.getVerifyKey(
      s.name,
      'ed25519:old',
      expiredTs - 1000,
      'event',
    );
    assert(ev instanceof CryptoKey);
    // event after expiry → refuse
    const late = await ks.getVerifyKey(
      s.name,
      'ed25519:old',
      expiredTs + 1000,
      'event',
    )
      .then(() => 'ok')
      .catch(() => 'refused');
    assertEquals(late, 'refused');
  });
});

Deno.test('key-is-name short-circuit: no fetch, the name IS the key', async () => {
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  const raw = await exportPublicKeyRaw(kp.publicKey);
  const name = b32encode(raw).toLowerCase().replace(/=+$/, '');
  await withStore(async (store) => {
    const ks = keyStore(await store.server(), {
      deps: stubDeps({
        directGet: () => {
          throw new Error('must not dial a key-is-name server');
        },
      }),
    });
    const key = await ks.getVerifyKey(name, 'ed25519:0', 0, 'request');
    assert(key instanceof CryptoKey);
    const doc = await ks.acquireKeyDoc(name, 0);
    assertEquals(Object.keys(doc.verify_keys), ['ed25519:0']);
    assertEquals(doc.signatures, {});
    assert(b32decode(name) !== null);
  });
});

Deno.test('witnesses-first: the stranger document comes from a roster peer; via recorded', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const stranger = await makeServer('stranger1.test');
    const w1 = await makeServer('w1.test');
    await seedServer(server, w1); // our cache holds w1's key (witness sig verifies)
    const strangerDoc = await makeDoc(stranger);
    const answer = await notaryAnswer(strangerDoc, w1);
    let directCalls = 0;
    const ks = keyStore(server, {
      deps: stubDeps({
        directGet: () => {
          directCalls++;
          return Promise.reject(new Error('direct should not fire'));
        },
        witnessQuery: (peer, name) => {
          assertEquals(peer, 'w1.test');
          assertEquals(name, 'stranger1.test');
          return Promise.resolve(answer);
        },
        listWitnesses: () => Promise.resolve(['w1.test']),
      }),
    });
    const doc = await ks.acquireKeyDoc(stranger.name, 0);
    assertEquals(doc.server_name, stranger.name);
    assertEquals(directCalls, 0);
    const row = await server.query(
      'SELECT via FROM server_key_docs WHERE server_name = ?',
      [stranger.name],
    );
    assertEquals(String(row[0].via), 'witness:w1.test');
  });
});

Deno.test('seniority: the senior usable answer wins; a differing junior is recorded as disagreement', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const stranger = await makeServer('stranger2.test');
    const w1 = await makeServer('senior.test');
    const w2 = await makeServer('junior.test');
    await seedServer(server, w1);
    await seedServer(server, w2);
    const seniorDoc = await makeDoc(stranger);
    const juniorDoc = await makeDoc(stranger, {
      kp: (await makeServer('other.test')).kp, // different key material
    });
    const ks = keyStore(server, {
      deps: stubDeps({
        witnessQuery: (peer) =>
          peer === 'senior.test'
            ? notaryAnswer(seniorDoc, w1)
            : notaryAnswer(juniorDoc, w2),
        listWitnesses: () => Promise.resolve(['senior.test', 'junior.test']),
      }),
    });
    const doc = await ks.acquireKeyDoc(stranger.name, 0);
    assertEquals(doc.valid_until_ts, seniorDoc.valid_until_ts);
    const pending = await server.query(
      "SELECT detail FROM federation_pending WHERE name = ? AND kind = 'disagreement'",
      [stranger.name],
    );
    assertEquals(pending.length, 1);
    const detail = JSON.parse(String(pending[0].detail));
    assertEquals(detail.senior, 'senior.test');
    assertEquals(detail.junior, 'junior.test');
  });
});

Deno.test('open-mode direct fallback only when zero witnesses answered', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const stranger = await makeServer('stranger3.test');
    const w1 = await makeServer('deaf.test');
    await seedServer(server, w1);
    const doc = await makeDoc(stranger);
    let directCalls = 0;
    const ks = keyStore(server, {
      deps: stubDeps({
        witnessQuery: () => Promise.reject(new Error('witness unreachable')),
        listWitnesses: () => Promise.resolve(['deaf.test']),
        directGet: () => {
          directCalls++;
          return Promise.resolve(doc);
        },
      }),
    });
    await ks.acquireKeyDoc(stranger.name, 0);
    assertEquals(directCalls, 1);
    const row = await server.query(
      'SELECT via FROM server_key_docs WHERE server_name = ?',
      [stranger.name],
    );
    assertEquals(String(row[0].via), 'direct');
  });
});

Deno.test('a failed fetch is remembered for keyfailminutes (no re-dial)', async () => {
  await withStore(async (store) => {
    const s = await makeServer('failing.test');
    let calls = 0;
    const ks = keyStore(await store.server(), {
      deps: stubDeps({
        directGet: () => {
          calls++;
          return Promise.reject(new Error('connection refused'));
        },
      }),
    });
    await assertRejects(() => ks.acquireKeyDoc(s.name, 0));
    assertEquals(calls, 1);
    await assertRejects(() => ks.acquireKeyDoc(s.name, 0));
    assertEquals(calls, 1); // remembered — no second dial
  });
});

Deno.test('one in-flight acquisition per name', async () => {
  await withStore(async (store) => {
    const s = await makeServer('concurrent.test');
    const doc = await makeDoc(s);
    let calls = 0;
    const ks = keyStore(await store.server(), {
      deps: stubDeps({
        directGet: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 150));
          return doc;
        },
      }),
    });
    const [a, b] = await Promise.all([
      ks.acquireKeyDoc(s.name, 0),
      ks.acquireKeyDoc(s.name, 0),
    ]);
    assertEquals(calls, 1);
    assertEquals(a.server_name, b.server_name);
  });
});

// --- keydoc: the notary answer from cache ---------------------------------

Deno.test('notary: the cached document verbatim with our signature added; canonical bytes', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const origin = await makeServer('origin.test');
    const seeded = await seedServer(server, origin);
    const { signer, publicKey } = await randomSigner('notary-us.test');
    const doc = await notaryFromCache(server, signer, 'origin.test');
    assert(doc !== null);
    // the origin's self-signature AND ours, side by side
    assertEquals(Object.keys(doc.signatures).sort(), [
      'notary-us.test',
      'origin.test',
    ]);
    assert(
      await verifyJson(doc, 'notary-us.test', signer.keyId, publicKey),
      'our notary signature verifies',
    );
    const originPub = await importPublicKeyFromRaw(
      b64decode(seeded.verify_keys[origin.keyId].key),
    );
    assert(
      await verifyJson(doc, 'origin.test', origin.keyId, originPub),
      'the origin self-signature is preserved',
    );
    // unknown name → null (no fetch on miss)
    assertEquals(await notaryFromCache(server, signer, 'unknown.test'), null);
    // the served bytes are the canonical form
    const res = keyDocResponse({ server_keys: [doc] });
    assertEquals(res.status, 200);
    assertEquals(await res.text(), canonicalJson({ server_keys: [doc] }));
  });
});

Deno.test('federation disabled → the keydoc precondition 404s', () => {
  setConfigForTests({ federation: { enabled: false } });
  try {
    assertFederationEnabled();
    throw new Error('should have thrown');
  } catch (e) {
    assert(e instanceof MatrixError);
    assertEquals((e as MatrixError).status, 404);
    assertEquals((e as MatrixError).errcode, 'M_UNRECOGNIZED');
  }
  setConfigForTests({ federation: { enabled: true } });
});
