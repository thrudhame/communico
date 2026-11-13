// The key/notary wire schema never edits signed JSON. Cryptographic identity
// and signatures are admitted by KeyStore, not this representation boundary.
import { objectOf, stringOf } from '#engine/net/json.ts';
import { protocol } from '#engine/net/upstream-error.ts';
import { matrixBase64 } from '#engine/signing-primitives.js';
import { canonicalJson } from '#engine/canonical.ts';

export type KeyDocShape = {
  server_name: string;
  verify_keys: Record<string, { key: string }>;
  old_verify_keys?: Record<string, { key: string; expired_ts: number }>;
  valid_until_ts: number;
  signatures: Record<string, Record<string, string>>;
};

// Omission is allowed on the wire; default only at consumption, never in JSON.
export function oldKeysOf(
  doc: KeyDocShape,
): NonNullable<KeyDocShape['old_verify_keys']> {
  return doc.old_verify_keys === undefined ? {} : doc.old_verify_keys;
}

function integer(raw: unknown): void {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    protocol('key-doc', 'expected integer timestamp');
  }
}

function keyMap(raw: unknown, old = false): void {
  for (const [id, value] of Object.entries(objectOf(raw, 'key-doc'))) {
    if (!/^[^:]+:[a-zA-Z0-9_]+$/.test(id)) {
      protocol('key-doc', 'invalid key identifier');
    }
    const entry = objectOf(value, 'key-doc');
    try {
      matrixBase64(entry.key, id.startsWith('ed25519:') ? 32 : undefined);
    } catch (cause) {
      protocol('key-doc', 'invalid key material', cause);
    }
    if (old) integer(entry.expired_ts);
  }
}

export function keyDocument(raw: unknown): KeyDocShape {
  const doc = objectOf(raw, 'key-doc');
  stringOf(doc.server_name, 'key-doc');
  integer(doc.valid_until_ts);
  keyMap(doc.verify_keys);
  if (doc.old_verify_keys !== undefined) {
    const oldKeys = objectOf(doc.old_verify_keys, 'key-doc');
    keyMap(oldKeys, true);
    for (const id of Object.keys(oldKeys)) {
      if (Object.hasOwn(doc.verify_keys as object, id)) {
        protocol('key-doc', 'key identifier is both current and retired');
      }
    }
  }
  for (const signatures of Object.values(objectOf(doc.signatures, 'key-doc'))) {
    for (const signature of Object.values(objectOf(signatures, 'key-doc'))) {
      stringOf(signature, 'key-doc');
    }
  }
  // All signed extension properties must also be representable canonically.
  const signed = { ...doc };
  delete signed.signatures;
  delete signed.unsigned;
  try {
    canonicalJson(signed);
  } catch (cause) {
    protocol('key-doc', 'invalid signed JSON', cause);
  }
  return doc as KeyDocShape;
}
