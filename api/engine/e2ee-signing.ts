// Cross-signing JSON validation is independent of storage and room signing.
import { assertCanonicalNumbers, canonicalJson } from '#engine/canonical.ts';
import {
  bounded,
  type Json,
  type KeyLimits,
  object,
} from '#engine/tenant/e2ee.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  b64decode,
  b64encodeStd,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';

export const signingUsages = [
  'master',
  'self_signing',
  'user_signing',
] as const;
export type SigningUsage = typeof signingUsages[number];
export type SigningKey = { id: string; public: string; json: string };
export type SigningUpload = Partial<Record<SigningUsage, SigningKey>>;
export function signingKey(
  value: unknown,
  user: string,
  usage: SigningUsage,
  limits: KeyLimits,
): SigningKey {
  bounded(value, limits.maxkeybytes);
  assertCanonicalNumbers(value);
  const key = object(value, 'signing key');
  const entries = Object.entries(object(key.keys, 'keys'));
  if (
    key.user_id !== user || !Array.isArray(key.usage) ||
    key.usage.length !== 1 || key.usage[0] !== usage || entries.length !== 1
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'invalid signing key owner, usage or key count',
    );
  }
  const [id, pub] = entries[0];
  let valid = false;
  try {
    valid = typeof pub === 'string' && b64decode(pub).length === 32 &&
      b64encodeStd(b64decode(pub)) === pub && id === 'ed25519:' + pub;
  } catch { /* Invalid base64. */ }
  if (!valid) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid signing public key');
  }
  if (key.signatures !== undefined) {
    for (const signer of Object.values(object(key.signatures, 'signatures'))) {
      if (
        Object.values(object(signer, 'signer')).some((sig) =>
          typeof sig !== 'string'
        )
      ) {
        throw new MatrixError(400, 'M_BAD_JSON', 'invalid signatures');
      }
    }
  }
  return { id, public: pub as string, json: canonicalJson(key) };
}
export function signingUpload(
  body: unknown,
  user: string,
  limits: KeyLimits,
): SigningUpload {
  bounded(body, limits.maxrequestbytes);
  const value = object(body, 'body'), result: SigningUpload = {};
  for (const usage of signingUsages) {
    const field = usage + '_key';
    if (value[field] !== undefined) {
      result[usage] = signingKey(value[field], user, usage, limits);
    }
  }
  return result;
}
export async function verifySigningKey(
  key: Json,
  user: string,
  signer: SigningKey,
): Promise<boolean> {
  return await verifyJson(
    key,
    user,
    signer.id,
    await importPublicKeyFromRaw(b64decode(signer.public)),
  );
}
