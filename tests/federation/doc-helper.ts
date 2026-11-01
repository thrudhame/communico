// tests/federation/doc-helper.ts — mint self-signed server key documents
// and seed them into the remembered-keys tables for federation tests.
// (doltgres tests/federation/doc-helper.ts, restored on the KeyStore.)
import type { Database as Db } from '#engine/store/db.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';
import {
  type KeyDoc,
  type KeysDeps,
  keyStore,
} from '#engine/federation/keys.ts';

export type TestServer = {
  name: string;
  keyId: string;
  kp: CryptoKeyPair;
};

export async function makeServer(name: string, keyId = 'ed25519:1') {
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  return { name, keyId, kp };
}

export async function makeDoc(
  server: TestServer,
  opts: {
    keyId?: string;
    kp?: CryptoKeyPair;
    extraVerifyKeys?: Record<string, string>;
    oldVerifyKeys?: Record<string, { key: string; expired_ts: number }>;
    validUntilMs?: number;
  } = {},
): Promise<KeyDoc> {
  const keyId = opts.keyId !== undefined ? opts.keyId : server.keyId;
  const kp = opts.kp !== undefined ? opts.kp : server.kp;
  const pubRaw = await exportPublicKeyRaw(kp.publicKey);
  const verifyKeys: Record<string, { key: string }> = {
    [keyId]: { key: b64encodeStd(pubRaw) },
  };
  for (const [id, key] of Object.entries(opts.extraVerifyKeys ?? {})) {
    verifyKeys[id] = { key };
  }
  const doc: KeyDoc = {
    server_name: server.name,
    verify_keys: verifyKeys,
    old_verify_keys: opts.oldVerifyKeys ?? {},
    valid_until_ts: opts.validUntilMs !== undefined
      ? opts.validUntilMs
      : Date.now() + 24 * 3600 * 1000,
    signatures: {},
  };
  await signJson(doc, server.name, keyId, kp.privateKey);
  return doc;
}

/** Stub transport answering only the direct fetch (no witnesses). */
export function directOnly(
  doc: unknown,
  counter?: { calls: number },
): KeysDeps {
  return {
    directGet: () => {
      if (counter !== undefined) counter.calls++;
      return Promise.resolve(doc);
    },
    witnessQuery: () => Promise.reject(new Error('no witnesses')),
    listWitnesses: () => Promise.resolve([]),
  };
}

/** Persist a server's own document as if directly fetched (via='direct'). */
export async function seedServer(
  server: Db,
  s: TestServer,
  doc?: KeyDoc,
): Promise<KeyDoc> {
  const d = doc !== undefined ? doc : await makeDoc(s);
  await keyStore(server, { deps: directOnly(d) }).acquireKeyDoc(s.name, 0);
  return d;
}

/** A notary answer ({server_keys: [doc]}) carrying the witness's own
 *  signature next to the origin's self-signature. */
export async function notaryAnswer(
  doc: KeyDoc,
  witness: TestServer,
): Promise<{ server_keys: KeyDoc[] }> {
  await signJson(doc, witness.name, witness.keyId, witness.kp.privateKey);
  return { server_keys: [doc] };
}
