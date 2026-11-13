// tests/federation-keys.test.ts — remembered server keys: our document,
// cache validity, purpose (request vs event), key-is-name short-circuit,
// witnesses-first acquisition with seniority + disagreement, direct
// fallback, failure memory, one in-flight per name. Stub transport over
// a real server file (doltgres tests/federation-keys.test.ts, restored)
// — plus the notary-from-cache serving data (keydoc.ts).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
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
  signJson,
  verifyJson,
} from '#engine/signing-primitives.js';
import {
  assertFederationEnabled,
  keyDocResponse,
  notaryFromCache,
} from '#engine/federation/keydoc.ts';
import {
  KeyChangeRefused,
  type KeysDeps,
  keyStore,
  ourKeyDocument,
} from '#engine/federation/keys.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { randomSigner } from './fixtures/signer.ts';
import type { Database } from '#engine/store/db.ts';
import { documentsFromAnswer } from '#engine/federation/witness.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
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
    assertEquals(got, far, 'the signed document is never rewritten');
    assert(await verifyJson(got, s.name, s.keyId, s.kp.publicKey));
    const [{ rows, doc }] = await ks.listServerKeys(s.name);
    assert(rows.every((row) => row.valid_until_ts <= cap));
    assertEquals(JSON.parse(doc!.key_json), far);
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

Deno.test('rotation: missing keys refresh a valid document and share the actual fetch', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const old = await makeServer('rotation.test');
    await seedServer(server, old);
    const next = await makeServer(old.name, 'ed25519:next');
    const extra = await makeServer(old.name, 'ed25519:extra');
    const doc = await makeDoc(next, {
      extraVerifyKeys: {
        [extra.keyId]: b64encodeStd(
          await exportPublicKeyRaw(extra.kp.publicKey),
        ),
      },
      oldVerifyKeys: {
        [old.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(old.kp.publicKey)),
          expired_ts: Date.now() + 3600_000,
        },
      },
    });
    let calls = 0;
    const ks = keyStore(server, {
      deps: stubDeps({
        directGet: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return doc;
        },
      }),
    });
    const [cached, a, b] = await Promise.all([
      ks.acquireKeyDoc(old.name, 0),
      ks.getVerifyKey(next.name, next.keyId, Date.now(), 'request'),
      ks.getVerifyKey(extra.name, extra.keyId, Date.now(), 'event'),
    ]);
    assertEquals(cached.server_name, old.name);
    assertEquals(calls, 1);
    assertEquals(
      await exportPublicKeyRaw(a),
      await exportPublicKeyRaw(next.kp.publicKey),
    );
    assertEquals(
      await exportPublicKeyRaw(b),
      await exportPublicKeyRaw(extra.kp.publicKey),
    );
    await assertRejects(() =>
      ks.getVerifyKey(old.name, old.keyId, Date.now(), 'request')
    );
    assert(
      await ks.getVerifyKey(old.name, old.keyId, Date.now(), 'event') instanceof
        CryptoKey,
    );
    assertEquals(
      calls,
      1,
      'a known retired key does not trigger another fetch',
    );
  });
});

Deno.test('rotation: missing-key failures are remembered per server without blocking cached keys', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('missing-key.test');
    const doc = await seedServer(server, s);
    const counter = { calls: 0 };
    const ks = keyStore(server, { deps: directOnly(doc, counter) });
    await assertRejects(() =>
      ks.getVerifyKey(s.name, 'ed25519:absent', 0, 'request')
    );
    assertEquals(counter.calls, 1, 'a missing key must actually be requested');
    await assertRejects(() =>
      ks.getVerifyKey(s.name, 'ed25519:another', 0, 'event')
    );
    assertEquals(
      counter.calls,
      1,
      'random key ids cannot bypass failure memory',
    );
    assert(
      await ks.getVerifyKey(s.name, s.keyId, 0, 'request') instanceof CryptoKey,
    );
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
        witnessQuery: () =>
          Promise.reject(
            new UpstreamError('transport', {
              phase: 'test',
              reason: 'witness unreachable',
            }),
          ),
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
          return Promise.reject(
            new UpstreamError('transport', {
              phase: 'test',
              reason: 'connection refused',
            }),
          );
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

Deno.test('key policy refusal is remembered separately and admin decisions clear acquisition memory', async () => {
  setConfigForTests({ federation: { keychange: 'block' } });
  try {
    for (const decision of ['accept', 'forget']) {
      await withStore(async (store) => {
        const db = await store.server();
        const old = await makeServer('refusal-' + decision + '.test');
        await seedServer(db, old, await makeDoc(old, { validUntilMs: 1 }));
        const next = await makeServer(old.name, 'ed25519:next');
        const candidate = await makeDoc(next);
        let calls = 0;
        const ks = keyStore(db, {
          deps: stubDeps({
            directGet: () => {
              calls++;
              return Promise.resolve(candidate);
            },
          }),
        });
        const refused = await assertRejects(
          () => ks.acquireKeyDoc(old.name, Date.now()),
          KeyChangeRefused,
        );
        assertStrictEquals(
          await assertRejects(() => ks.acquireKeyDoc(old.name, Date.now())),
          refused,
        );
        assertEquals(calls, 1, 'policy refusal must not redial');
        assertEquals(
          (await ks.listKeyChanges(old.name)).length,
          1,
          'one pending admin decision',
        );
        // Admin and production resolvers can hold separate key-store views of
        // the same server file. A decision must invalidate both views.
        const admin = keyStore(await store.server(), {
          deps: directOnly(candidate),
        });
        if (decision === 'accept') {
          assert(await admin.acceptKeyChange(old.name));
        } else await admin.forgetServerKeys(old.name);
        assertEquals(await ks.acquireKeyDoc(old.name, Date.now()), candidate);
        assertEquals(calls, decision === 'accept' ? 1 : 2);
      });
    }
  } finally {
    setConfigForTests({});
  }
});

Deno.test('forget clears peer failure memory as well as persisted keys', async () => {
  await withStore(async (store) => {
    const doc = await makeDoc(await makeServer('forget-failure.test'));
    let failing = true;
    const server = await store.server();
    const ks = keyStore(server, {
      deps: stubDeps({
        directGet: () => {
          if (failing) {
            throw new UpstreamError('transport', {
              phase: 'test',
              reason: 'offline',
            });
          }
          return Promise.resolve(doc);
        },
      }),
    });
    await assertRejects(() => ks.acquireKeyDoc(doc.server_name, 0));
    failing = false;
    await keyStore(await store.server(), {
      deps: directOnly(doc),
    }).forgetServerKeys(doc.server_name);
    assertEquals(await ks.acquireKeyDoc(doc.server_name, 0), doc);
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

Deno.test('key boundary: optional old keys stay absent and far-future witness signatures survive', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    const origin = await makeServer('intact-origin.test');
    const witness = await makeServer('intact-witness.test');
    await seedServer(db, witness);
    const doc = await makeDoc(origin, {
      validUntilMs: Date.now() + 30 * 86400_000,
    });
    delete (doc as { old_verify_keys?: unknown }).old_verify_keys;
    await signJson(doc, origin.name, origin.keyId, origin.kp.privateKey);
    const answer = await notaryAnswer(doc, witness);
    const original = structuredClone(doc);
    const ks = keyStore(db, {
      deps: stubDeps({
        listWitnesses: () => Promise.resolve([witness.name]),
        witnessQuery: () => Promise.resolve(answer),
        directGet: () => {
          throw new Error('must use the signed witness document');
        },
      }),
    });
    const got = await ks.acquireKeyDoc(origin.name, 0);
    assertEquals(got, original);
    assertEquals(Object.hasOwn(got, 'old_verify_keys'), false);
    assert(
      await verifyJson(got, origin.name, origin.keyId, origin.kp.publicKey),
    );
    assert(
      await verifyJson(got, witness.name, witness.keyId, witness.kp.publicKey),
    );
    const [{ rows, doc: saved }] = await ks.listServerKeys(origin.name);
    assertEquals(JSON.parse(saved!.key_json), original);
    assertEquals(rows[0].valid_until_ts, saved!.fetched_ms + 7 * 86400_000);
    // Cache eligibility uses the original acquisition cap, not the signed date.
    let refreshed = 0;
    const reloaded = keyStore(db, {
      deps: directOnly(doc, {
        get calls() {
          return refreshed;
        },
        set calls(n) {
          refreshed = n;
        },
      }),
    });
    await reloaded.acquireKeyDoc(
      origin.name,
      saved!.fetched_ms + 8 * 86400_000,
    );
    assertEquals(refreshed, 1);
  });
});

Deno.test('key boundary: decode every key entry before persistence, including unknown algorithms', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    const origin = await makeServer('schema-origin.test');
    const publicKey = b64encodeStd(
      await exportPublicKeyRaw(origin.kp.publicKey),
    );
    const mutations: ((doc: Record<string, unknown>) => void)[] = [
      (d) => {
        d.valid_until_ts = 1.5;
      },
      (d) => {
        d.verify_keys = [];
      },
      (d) => {
        d.old_verify_keys = null;
      },
      (d) => {
        d.old_verify_keys = [];
      },
      (d) => {
        d.old_verify_keys = { 'ed25519:old': { key: publicKey } };
      },
      (d) => {
        d.old_verify_keys = {
          'ed25519:old': { key: publicKey, expired_ts: '1' },
        };
      },
      (d) => {
        d.old_verify_keys = { 'future:old': { key: 12, expired_ts: 1 } };
      },
      (d) => {
        (d.verify_keys as Record<string, unknown>)['future:new'] = { key: 12 };
      },
      (d) => {
        (d.verify_keys as Record<string, unknown>)['future:bad-version'] = {
          key: 'AA',
        };
      },
      (d) => {
        (d.verify_keys as Record<string, unknown>)['ed25519:short'] = {
          key: 'AA',
        };
      },
      (d) => {
        (d.verify_keys as Record<string, unknown>)['future:padding'] = {
          key: 'AA=',
        };
      },
      (d) => {
        (d.verify_keys as Record<string, unknown>)['future:padbits'] = {
          key: 'AB',
        };
      },
      (d) => {
        (d.signatures as Record<string, unknown>)['other.test'] = [];
      },
      (d) => {
        (d.signatures as Record<string, unknown>)['other.test'] = {
          'ed25519:a': 12,
        };
      },
    ];
    for (const mutate of mutations) {
      const doc = await makeDoc(origin);
      mutate(doc as unknown as Record<string, unknown>);
      // Re-sign every canonicalizable mutation, proving schema not stale signature.
      if (Number.isInteger(doc.valid_until_ts)) {
        await signJson(doc, origin.name, origin.keyId, origin.kp.privateKey);
      }
      const ks = keyStore(db, { deps: directOnly(doc) });
      const error = await assertRejects(() => ks.acquireKeyDoc(origin.name, 0));
      assert(error instanceof UpstreamError);
      assertEquals(error.category, 'protocol');
      assertEquals((await ks.listServerKeys(origin.name))[0].doc, null);
      // Each mutation is a fresh contact, not a repeat of the first cached
      // protocol failure. Use the actual admin owner to clear shared memory.
      await ks.forgetServerKeys(origin.name);
    }
    // Unknown algorithms obey the shared entry grammar but not Ed25519 length.
    const valid = await makeDoc(origin, {
      extraVerifyKeys: {
        'future:a': 'AA',
        'future:padded': 'AA==',
        'future:ed': b64encodeStd(
          await exportPublicKeyRaw(origin.kp.publicKey),
        ),
      },
    });
    const validStore = keyStore(db, { deps: directOnly(valid) });
    await validStore.acquireKeyDoc(origin.name, 0);
    await assertRejects(
      () => validStore.getVerifyKey(origin.name, 'future:ed', 0, 'request'),
      UpstreamError,
    );
  });
});

Deno.test('key boundary: notary envelope is an array of objects, not a bare document or false empty', async () => {
  const origin = await makeServer('notary-shape.test');
  const doc = await makeDoc(origin);
  for (
    const raw of [doc, {}, [], { server_keys: null }, { server_keys: [null] }, {
      server_keys: [12],
    }]
  ) {
    try {
      documentsFromAnswer(raw, origin.name);
      throw new Error('malformed notary answer accepted');
    } catch (error) {
      assert(error instanceof UpstreamError);
      assertEquals(error.category, 'protocol');
    }
  }
  assertEquals(documentsFromAnswer({ server_keys: [] }, origin.name), []);
  assertEquals(documentsFromAnswer({ server_keys: [doc] }, origin.name), [doc]);
});

Deno.test('key boundary: an unverifiable notary document cannot hide a later usable document', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    const origin = await makeServer('notary-multiple.test');
    const witness = await makeServer('notary-multi-witness.test');
    await seedServer(db, witness);
    const bad = await makeDoc(origin);
    bad.signatures[origin.name][origin.keyId] = 'invalid';
    await notaryAnswer(bad, witness);
    const good = await makeDoc(origin);
    await notaryAnswer(good, witness);
    const ks = keyStore(db, {
      deps: stubDeps({
        listWitnesses: () => Promise.resolve([witness.name]),
        witnessQuery: () => Promise.resolve({ server_keys: [bad, good] }),
        directGet: () => {
          throw new Error('valid notary document was hidden');
        },
      }),
    });
    assertEquals(await ks.acquireKeyDoc(origin.name, 0), good);
  });
});

Deno.test('key boundary: expired cached witness keys cannot authenticate a notary answer', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    const origin = await makeServer('witness-expiry-origin.test');
    const witness = await makeServer('expired-witness.test');
    await seedServer(
      db,
      witness,
      await makeDoc(witness, { validUntilMs: Date.now() - 1000 }),
    );
    const doc = await makeDoc(origin);
    const answer = await notaryAnswer(doc, witness);
    let direct = 0;
    const ks = keyStore(db, {
      deps: stubDeps({
        listWitnesses: () => Promise.resolve([witness.name]),
        witnessQuery: () => Promise.resolve(answer),
        directGet: () => {
          direct++;
          return Promise.resolve(doc);
        },
      }),
    });
    await ks.acquireKeyDoc(origin.name, 0);
    assertEquals(direct, 1);
    assertEquals((await ks.listServerKeys(origin.name))[0].doc!.via, 'direct');
  });
});

Deno.test('key boundary: local and cancellation faults never poison failure memory', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    const origin = await makeServer('local-key.test');
    const witness = await makeServer('local-witness.test');
    await seedServer(db, witness);
    const doc = await makeDoc(origin);
    const answer = await notaryAnswer(doc, witness);
    for (
      const phase of [
        'direct',
        'roster',
        'witness-query',
        'witness-store',
        'persist',
        'cancel',
      ]
    ) {
      const fault = phase === 'cancel'
        ? new DOMException('cancelled', 'AbortError')
        : new Error('local ' + phase);
      let fail = true;
      const patched = new Proxy(db, {
        get(target, property) {
          if (property === 'query') {
            return (sql: string, params: unknown[]) => {
              if (
                fail && phase === 'witness-store' &&
                sql.includes('FROM server_keys') && params[0] === witness.name
              ) throw fault;
              return target.query(
                sql,
                params as Parameters<Database['query']>[1],
              );
            };
          }
          if (property === 'tx') {
            return (...args: Parameters<Database['tx']>) => {
              if (fail && phase === 'persist') throw fault;
              return target.tx(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const ks = keyStore(patched, {
        deps: stubDeps({
          directGet: () => {
            if (fail && ['direct', 'cancel'].includes(phase)) throw fault;
            return Promise.resolve(doc);
          },
          listWitnesses: () => {
            if (fail && phase === 'roster') throw fault;
            return Promise.resolve(
              phase.startsWith('witness') ? [witness.name] : [],
            );
          },
          witnessQuery: () => {
            if (fail && phase === 'witness-query') throw fault;
            return Promise.resolve(answer);
          },
        }),
      });
      assertStrictEquals(
        await assertRejects(() => ks.acquireKeyDoc(origin.name, 0)),
        fault,
      );
      fail = false;
      assertEquals(
        (await ks.acquireKeyDoc(origin.name, 0)).server_name,
        origin.name,
      );
      await ks.forgetServerKeys(origin.name);
    }
  });
});

Deno.test('key fault ownership: production event resolver does not turn local reads into bad signatures', async () => {
  await withStore(async (store) => {
    const db = await store.server();
    const fault = new Error('key cache read fault');
    const broken = new Proxy(db, {
      get(target, property) {
        if (property === 'query') {
          return () => {
            throw fault;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { signer } = await randomSigner('local.test');
    const resolver = productionKeyResolver(broken, signer);
    assertStrictEquals(
      await assertRejects(() =>
        resolver.verifyEventSignature({
          server: 'origin.test',
          keyId: 'ed25519:1',
          pdu: {} as never,
          roomVersion: '11',
          minValidUntilMs: 0,
        })
      ),
      fault,
    );
  });
});

Deno.test('key boundary: negative memory preserves the peer failure category', async () => {
  await withStore(async (store) => {
    const fault = new UpstreamError('protocol', {
      phase: 'key-doc',
      reason: 'invalid key document',
    });
    let calls = 0;
    const ks = keyStore(await store.server(), {
      deps: stubDeps({
        directGet: () => {
          calls++;
          throw fault;
        },
      }),
    });
    assertStrictEquals(
      await assertRejects(() => ks.acquireKeyDoc('bad.test', 0)),
      fault,
    );
    assertStrictEquals(
      await assertRejects(() => ks.acquireKeyDoc('bad.test', 0)),
      fault,
    );
    assertEquals(calls, 1);
  });
});
