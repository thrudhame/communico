// Public cross-signing validation shared by federation query, snapshots and EDUs.
import { canonicalJson } from '#engine/canonical.ts';
import { keyView } from '#engine/e2ee-key-view.ts';
import { decodeSigningKey, verifySigningKey } from '#engine/e2ee-signing.ts';
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
} from '#engine/e2ee-wire.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

export type PublicSigning = { master_key?: Json; self_signing_key?: Json };
export class InvalidPublicSigning extends UpstreamError {
  constructor(reason: string) {
    super('validation', { phase: 'e2ee-signature', reason });
  }
}
export function publicSigning(
  raw: unknown,
  user: string,
  limits: KeyLimits,
): PublicSigning {
  bounded(raw, limits.maxrequestbytes);
  const value = object(raw, 'public signing keys'), result: PublicSigning = {};
  for (const usage of ['master', 'self_signing'] as const) {
    const field = `${usage}_key` as keyof PublicSigning;
    if (value[field] === undefined) continue;
    const key = decodeSigningKey(value[field], user, usage, limits);
    result[field] = keyView(JSON.parse(key.json), user);
  }
  limitEntries(Object.keys(result).length, limits.maxkeys);
  bounded(result, limits.maxrequestbytes);
  return result;
}

/** Missing fields are replaced on snapshots; an EDU patches the current set. */
export async function verifiedPublicSigning(
  supplied: PublicSigning,
  user: string,
  limits: KeyLimits,
  prior?: PublicSigning,
): Promise<PublicSigning> {
  const result = { ...prior, ...supplied };
  if (
    prior?.master_key && supplied.master_key &&
    canonicalJson(prior.master_key.keys) !==
      canonicalJson(supplied.master_key.keys) &&
    supplied.self_signing_key === undefined
  ) {
    delete result.self_signing_key;
  }
  if (result.self_signing_key !== undefined) {
    if (
      result.master_key === undefined || !await verifySigningKey(
        result.self_signing_key,
        user,
        decodeSigningKey(result.master_key, user, 'master', limits),
      )
    ) throw new InvalidPublicSigning('invalid public subordinate signature');
  }
  try {
    limitEntries(Object.keys(result).length, limits.maxkeys);
    bounded(result, limits.maxrequestbytes);
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    throw new InvalidPublicSigning(String(e));
  }
  return result;
}

export function signingViews(
  keys: PublicSigning,
  user: string,
  requester: string,
): Json {
  const result: Json = {};
  for (const usage of ['master', 'self_signing'] as const) {
    const key = keys[`${usage}_key`];
    if (key !== undefined) {
      result[`${usage}_keys`] = { [user]: keyView(key, user, requester) };
    }
  }
  return result;
}
