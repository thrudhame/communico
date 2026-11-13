// Remote E2EE schemas own wire grammar, not authenticated-upload vocabulary.
import type { Config } from '#engine/config-schema.ts';
import { assertCanonicalNumbers, canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { limit, protocol, UpstreamError } from '#engine/net/upstream-error.ts';
import { matrixBase64 } from '#engine/signing-primitives.js';

export type Json = Record<string, unknown>;
export type KeyLimits = Config['e2ee'];
const phase = 'e2ee-schema';
export function object(raw: unknown, name: string): Json {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    protocol(phase, name + ' must be an object');
  }
  return raw as Json;
}
export function bounded(raw: unknown, max: number): void {
  if (new TextEncoder().encode(JSON.stringify(raw)).length > max) {
    limit(phase, 'E2EE object exceeds configured limit');
  }
}
export function limitEntries(count: number, max: number): void {
  if (count > max) limit(phase, 'too many E2EE entries');
}
export function identity(reason: string): never {
  throw new UpstreamError('validation', { phase, reason });
}
export function keyId(id: string): [string, string] {
  const colon = id.indexOf(':');
  if (colon < 1 || colon === id.length - 1 || id.length > 512) {
    protocol(phase, 'invalid key ID');
  }
  return [id.slice(0, colon), id.slice(colon + 1)];
}
export function material(raw: unknown, length: number): Uint8Array {
  try {
    return matrixBase64(raw, length);
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof DOMException)) {
      throw error;
    }
    protocol(phase, 'invalid E2EE base64 material', error);
  }
}
export function signatures(raw: unknown): void {
  for (const keys of Object.values(object(raw, 'signatures'))) {
    for (const [id, sig] of Object.entries(object(keys, 'signer keys'))) {
      const [algorithm] = keyId(id);
      if (typeof sig !== 'string') {
        protocol(phase, 'signature must be a string');
      }
      if (algorithm === 'ed25519') material(sig, 64);
    }
  }
}
export function canonical(raw: unknown): string {
  // This catch surrounds only the known canonical-number decoder, not I/O.
  try {
    assertCanonicalNumbers(raw);
  } catch (error) {
    if (!(error instanceof MatrixError)) throw error;
    protocol(phase, 'invalid canonical key JSON', error);
  }
  return canonicalJson(raw);
}
export function deviceKey(raw: unknown, limits: KeyLimits): Json {
  bounded(raw, limits.maxkeybytes);
  const key = object(raw, 'device key');
  if (typeof key.user_id !== 'string' || typeof key.device_id !== 'string') {
    protocol(phase, 'invalid device identity');
  }
  if (
    !Array.isArray(key.algorithms) ||
    key.algorithms.some((a) => typeof a !== 'string')
  ) {
    protocol(phase, 'invalid device algorithms');
  }
  for (const [id, pub] of Object.entries(object(key.keys, 'device keys'))) {
    const [algorithm] = keyId(id);
    if (typeof pub !== 'string') protocol(phase, 'public key must be a string');
    if (algorithm === 'ed25519' || algorithm === 'curve25519') {
      material(pub, 32);
    }
  }
  signatures(key.signatures);
  if (key.unsigned !== undefined) {
    const unsigned = object(key.unsigned, 'unsigned device info');
    if (
      unsigned.device_display_name !== undefined &&
      typeof unsigned.device_display_name !== 'string'
    ) {
      protocol(phase, 'invalid device display name');
    }
  }
  return JSON.parse(canonical(key));
}
export function claimedKey(
  raw: unknown,
  algorithm: string,
  limits: KeyLimits,
): void {
  bounded(raw, limits.maxkeybytes);
  if (typeof raw === 'string') {
    if (algorithm === 'signed_curve25519') {
      protocol(phase, 'signed key must be an object');
    }
    if (algorithm === 'curve25519' || algorithm === 'ed25519') {
      material(raw, 32);
    }
  } else {
    if (algorithm === 'curve25519' || algorithm === 'ed25519') {
      protocol(phase, 'unsigned key must be a string');
    }
    const key = object(raw, 'claimed signed key');
    if (
      typeof key.key !== 'string' ||
      (key.fallback !== undefined && typeof key.fallback !== 'boolean')
    ) {
      protocol(phase, 'invalid signed key');
    }
    signatures(key.signatures);
    if (algorithm === 'signed_curve25519') material(key.key, 32);
  }
  canonical(raw);
}
