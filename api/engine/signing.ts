// api/engine/signing.ts — server-side PDU signing (F0 dev key).
// Order per spec (server-server API § "Adding hashes and signatures to
// outgoing events"): content hash -> redact -> sign. The shared WebCrypto
// primitives live in lite/web/sync/signing.js; this module adds the
// persistent server key (db-init generates once, reuses forever — never
// rotates; F1 moves the same key into the tenant table).
import { SERVER_DB, withDb } from './db.ts';
import { SERVER_NAME } from './config.ts';
import { eventIdFor, redact } from './eventid.ts';
import type { Pdu } from './pdu.ts';
import {
  b64decode,
  b64encode,
  contentHashOf,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
  signJson,
  verifyJson,
} from '../../lite/web/sync/signing.js';

export const SERVER_KEY_ID = '1';

export interface ServerKey {
  keyId: string;
  serverName: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicB64: string;
}

export async function ensureServerKey(serverName = SERVER_NAME): Promise<ServerKey> {
  return await withDb(SERVER_DB, async (c) => {
    await c.query(
      `CREATE TABLE IF NOT EXISTS server_signing_key (
         key_id text PRIMARY KEY,
         server_name text NOT NULL,
         pubkey_b64 text NOT NULL,
         privkey_pkcs8_b64 text NOT NULL,
         created_ms bigint NOT NULL
       );`,
    );
    const existing = await c.query(
      'SELECT key_id, server_name, pubkey_b64, privkey_pkcs8_b64 FROM server_signing_key LIMIT 1;',
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as Record<string, unknown>;
      const pubRaw = b64decode(String(row.pubkey_b64));
      const privDer = b64decode(String(row.privkey_pkcs8_b64));
      return {
        keyId: String(row.key_id),
        serverName: String(row.server_name),
        publicKey: await importPublicKeyFromRaw(pubRaw),
        privateKey: await importPrivateKeyFromPkcs8(privDer),
        publicB64: String(row.pubkey_b64),
      };
    }
    const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
    const pubRaw = await exportPublicKeyRaw(kp.publicKey);
    const privDer = await exportPrivateKeyPkcs8(kp.privateKey);
    const pubB64 = b64encode(pubRaw);
    const privB64 = b64encode(privDer);
    await c.query(
      'INSERT INTO server_signing_key (key_id, server_name, pubkey_b64, privkey_pkcs8_b64, created_ms) VALUES ($1, $2, $3, $4, $5);',
      [SERVER_KEY_ID, serverName, pubB64, privB64, Date.now()],
    );
    return {
      keyId: SERVER_KEY_ID,
      serverName,
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicB64: pubB64,
    };
  });
}

// Author-finalize a locally built PDU: content-hash, reference-hash id,
// redact-then-sign (spec § hash_and_sign_event: the signature covers the
// REDACTED form + hashes, so it verifies on redacted copies; signatures
// are copied back to the full event). Mutates and returns the same object.
export async function signPdu(
  pdu: Pdu,
  roomVersion: string,
  key: ServerKey,
): Promise<Pdu> {
  pdu.hashes = { sha256: await contentHashOf(pdu as unknown as Record<string, unknown>) };
  pdu.event_id = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    roomVersion,
  );
  const redacted = redact(
    pdu as unknown as Record<string, unknown>,
    roomVersion,
  );
  await signJson(
    redacted,
    key.serverName,
    'ed25519:' + key.keyId,
    key.privateKey as unknown as Parameters<typeof signJson>[3],
  );
  pdu.signatures = (redacted.signatures ?? {}) as Record<
    string,
    Record<string, string>
  >;
  return pdu;
}

// Verify an inbound PDU's origin signature when present: redact first
// (the signature covers the redacted form), then check. Unsigned PDUs
// are NOT accepted here — the ALLOW_UNSIGNED_LITE seam lives at ingest,
// which knows the sender engine.
export async function verifyPduSignature(
  pdu: Pdu,
  publicKey: CryptoKey,
  serverName: string,
  keyId: string,
): Promise<boolean> {
  let redacted: Record<string, unknown>;
  try {
    redacted = redact(pdu as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
  // verify against the redacted copy (full signatures map retained for lookup)
  redacted.signatures = pdu.signatures as unknown as Record<
    string,
    Record<string, string>
  >;
  return await verifyJson(
    redacted,
    serverName,
    keyId,
    publicKey as unknown as Parameters<typeof verifyJson>[3],
  );
}
