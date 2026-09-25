// tests/federation-keys.test.ts — remembered server keys: our document,
// cache validity, purpose (request vs event), key-is-name short-circuit,
// witnesses-first acquisition with seniority + disagreement, direct
// fallback, failure memory, one in-flight per name. Stub transport.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { serverDb, withDb } from '#engine/db.ts';
import { serverName } from '#engine/config.ts';
import {
  b64decode,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';
import {
  acquireKeyDocWith,
  getVerifyKeyWith,
  type KeysDeps,
  ourKeyDocument,
} from '#engine/federation/keys.ts';
import {
  makeDoc,
  makeServer,
  notaryAnswer,
  seedServer,
} from './federation/doc-helper.ts';
import { resetFederationTables } from './util.ts';

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
  const doc = await ourKeyDocument();
  assertEquals(doc.server_name, serverName());
  const ids = Object.keys(doc.verify_keys);
  assertEquals(ids.length, 1);
  assert(ids[0].startsWith('ed25519:'), `key id: ${ids[0]}`);
  const keyB64 = doc.verify_keys[ids[0]].key;
  assert(/^[A-Za-z0-9+/]*$/.test(keyB64), `standard alphabet: ${keyB64}`);
  assert(!keyB64.includes('='), `unpadded: ${keyB64}`);
  assert(doc.valid_until_ts > Date.now());
  assert(doc.old_verify_keys !== undefined);
  const signers = Object.keys(doc.signatures);
  assertEquals(signers, [serverName()]);
  const pub = await getOwnPub();
  assert(await verifyJson(doc, serverName(), ids[0], pub));
});

async function getOwnPub(): Promise<CryptoKey> {
  // our own key via the same path any reader uses
  const doc = await ourKeyDocument();
  const id = Object.keys(doc.verify_keys)[0];
  return await importPublicKeyFromRaw(b64decode(doc.verify_keys[id].key));
}

Deno.test('cache: second acquire does not refetch; horizon past valid_until_ts refetches; 7-day cap', async () => {
  await resetFederationTables();
  const s = await makeServer('cache1.test');
  const doc = await makeDoc(s, { validUntilMs: Date.now() + 3600_000 });
  let directCalls = 0;
  const deps = stubDeps({
    directGet: () => {
      directCalls++;
      return Promise.resolve(doc);
    },
  });
  await acquireKeyDocWith(s.name, 0, deps);
  assertEquals(directCalls, 1);
  await acquireKeyDocWith(s.name, 0, deps); // cache hit
  assertEquals(directCalls, 1);
  // horizon beyond the document's validity → refetch
  await acquireKeyDocWith(s.name, Date.now() + 2 * 3600_000, deps);
  assertEquals(directCalls, 2);

  // 7-day cap on stored validity
  await resetFederationTables();
  const far = await makeDoc(s, { validUntilMs: Date.now() + 30 * 86400_000 });
  const deps2 = stubDeps({ directGet: () => Promise.resolve(far) });
  const got = await acquireKeyDocWith(s.name, 0, deps2);
  const cap = Date.now() + 7 * 86400_000;
  assert(
    got.valid_until_ts <= cap,
    `valid_until_ts ${got.valid_until_ts} > cap ${cap}`,
  );
});

Deno.test('purpose: a retired key never authenticates a request; events within expired_ts pass', async () => {
  await resetFederationTables();
  const s = await makeServer('purpose.test');
  const retired = await makeServer('purpose-old.test');
  const oldRaw = await (async () => {
    const { exportPublicKeyRaw, b64encodeStd } = await import(
      '#engine/signing-primitives.js'
    );
    return b64encodeStd(await exportPublicKeyRaw(retired.kp.publicKey));
  })();
  const expiredTs = Date.now() + 3600_000;
  const doc = await makeDoc(s, {
    oldVerifyKeys: { 'ed25519:old': { key: oldRaw, expired_ts: expiredTs } },
  });
  const deps = stubDeps({ directGet: () => Promise.resolve(doc) });
  await acquireKeyDocWith(s.name, 0, deps);
  // request auth with the retired key → refuse
  const reqResult = await getVerifyKeyWith(
    s.name,
    'ed25519:old',
    Date.now(),
    'request',
    deps,
  )
    .then(() => 'ok')
    .catch(() => 'refused');
  assertEquals(reqResult, 'refused');
  // event signed before expiry → the retired key verifies it
  const ev = await getVerifyKeyWith(
    s.name,
    'ed25519:old',
    expiredTs - 1000,
    'event',
    deps,
  );
  assert(ev instanceof CryptoKey);
  // event after expiry → refuse
  const late = await getVerifyKeyWith(
    s.name,
    'ed25519:old',
    expiredTs + 1000,
    'event',
    deps,
  )
    .then(() => 'ok')
    .catch(() => 'refused');
  assertEquals(late, 'refused');
});

Deno.test('key-is-name short-circuit: no fetch, the name IS the key', async () => {
  const { b32encode, exportPublicKeyRaw, generateSigningKeypair, b32decode } =
    await import('#engine/signing-primitives.js');
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  const raw = await exportPublicKeyRaw(kp.publicKey);
  const name = b32encode(raw).toLowerCase().replace(/=+$/, '');
  const deps = stubDeps({
    directGet: () => {
      throw new Error('must not dial a key-is-name server');
    },
  });
  const key = await getVerifyKeyWith(name, 'ed25519:0', 0, 'request', deps);
  assert(key instanceof CryptoKey);
  const doc = await acquireKeyDocWith(name, 0, deps);
  assertEquals(Object.keys(doc.verify_keys), ['ed25519:0']);
  assertEquals(doc.signatures, {});
  assert(b32decode(name) !== null);
});

Deno.test('witnesses-first: the stranger document comes from a roster peer; via recorded', async () => {
  await resetFederationTables();
  const stranger = await makeServer('stranger1.test');
  const w1 = await makeServer('w1.test');
  await seedServer(w1); // our cache holds w1's key (witness sig verifies)
  const strangerDoc = await makeDoc(stranger);
  const answer = await notaryAnswer(strangerDoc, w1);
  let directCalls = 0;
  const deps = stubDeps({
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
  });
  const doc = await acquireKeyDocWith(stranger.name, 0, deps);
  assertEquals(doc.server_name, stranger.name);
  assertEquals(directCalls, 0);
  const row = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT via FROM server_key_docs WHERE server_name = $1;',
      [stranger.name],
    );
    return r.rows[0] as Record<string, unknown>;
  });
  assertEquals(String(row.via), 'witness:w1.test');
});

Deno.test('seniority: the senior usable answer wins; a differing junior is recorded as disagreement', async () => {
  await resetFederationTables();
  const stranger = await makeServer('stranger2.test');
  const w1 = await makeServer('senior.test');
  const w2 = await makeServer('junior.test');
  await seedServer(w1);
  await seedServer(w2);
  const seniorDoc = await makeDoc(stranger);
  const juniorDoc = await makeDoc(stranger, {
    kp: (await makeServer('other.test')).kp, // different key material
  });
  const deps = stubDeps({
    witnessQuery: (peer) =>
      peer === 'senior.test'
        ? notaryAnswer(seniorDoc, w1)
        : notaryAnswer(juniorDoc, w2),
    listWitnesses: () => Promise.resolve(['senior.test', 'junior.test']),
  });
  const doc = await acquireKeyDocWith(stranger.name, 0, deps);
  assertEquals(doc.valid_until_ts, seniorDoc.valid_until_ts);
  const pending = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      "SELECT detail FROM federation_pending WHERE name = $1 AND kind = 'disagreement';",
      [stranger.name],
    );
    return r.rows;
  });
  assertEquals(pending.length, 1);
  const detail = JSON.parse(
    String((pending[0] as Record<string, unknown>).detail),
  );
  assertEquals(detail.senior, 'senior.test');
  assertEquals(detail.junior, 'junior.test');
});

Deno.test('open-mode direct fallback only when zero witnesses answered', async () => {
  await resetFederationTables();
  const stranger = await makeServer('stranger3.test');
  const w1 = await makeServer('deaf.test');
  await seedServer(w1);
  const doc = await makeDoc(stranger);
  let directCalls = 0;
  const deps = stubDeps({
    witnessQuery: () => Promise.reject(new Error('witness unreachable')),
    listWitnesses: () => Promise.resolve(['deaf.test']),
    directGet: () => {
      directCalls++;
      return Promise.resolve(doc);
    },
  });
  await acquireKeyDocWith(stranger.name, 0, deps);
  assertEquals(directCalls, 1);
  const row = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT via FROM server_key_docs WHERE server_name = $1;',
      [stranger.name],
    );
    return r.rows[0] as Record<string, unknown>;
  });
  assertEquals(String(row.via), 'direct');
});

Deno.test('a failed fetch is remembered for keyfailminutes (no re-dial)', async () => {
  await resetFederationTables();
  const s = await makeServer('failing.test');
  let calls = 0;
  const deps = stubDeps({
    directGet: () => {
      calls++;
      return Promise.reject(new Error('connection refused'));
    },
  });
  await assertRejects(() => acquireKeyDocWith(s.name, 0, deps));
  assertEquals(calls, 1);
  await assertRejects(() => acquireKeyDocWith(s.name, 0, deps));
  assertEquals(calls, 1); // remembered — no second dial
});

Deno.test('one in-flight acquisition per name', async () => {
  await resetFederationTables();
  const s = await makeServer('concurrent.test');
  const doc = await makeDoc(s);
  let calls = 0;
  const deps = stubDeps({
    directGet: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return doc;
    },
  });
  const [a, b] = await Promise.all([
    acquireKeyDocWith(s.name, 0, deps),
    acquireKeyDocWith(s.name, 0, deps),
  ]);
  assertEquals(calls, 1);
  assertEquals(a.server_name, b.server_name);
});
