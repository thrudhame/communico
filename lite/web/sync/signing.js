// sync/signing.js — shared JSON/hash/signing primitives (spec v1.11
// server-server API § "Signing Events" + appendices § Canonical JSON,
// Signing JSON, Cryptographic Test Vectors).
//
// Order per spec: content hash -> redact -> sign. Shared by both engines
// (server imports this from api/engine/signing.ts); WebCrypto Ed25519
// only — no dependencies.
import { canonicalJson } from './canonical.js';

// Unpadded base64 (appendices § Unpadded Base64: RFC 4648 without `=`).
// Binary values in JSON (hashes, signatures, keys) use the STANDARD
// alphabet; only event ids use the URL-safe variation (rooms v11 §
// Event IDs: 62nd/63rd chars `-`/`_` instead of `+`/`/`).
export function b64encode(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Standard unpadded base64 — for hashes, signatures, keys.
export function b64encodeStd(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/=+$/, '');
}

export function b64decode(s) {
  const padded = String(s).replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (String(s).length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256bytes(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}

export async function sha256ofString(s) {
  return await sha256bytes(new TextEncoder().encode(s));
}

// Content hash (spec § "Calculating the content hash for an event"):
// covers the COMPLETE event including the *unredacted* contents. Remove
// `unsigned`, `signatures`, `hashes`, canonical-encode, SHA-256.
// NOTE: this is spec-literal and does NOT strip `event_id` (v1 wire
// events carry one, and the appendix vectors hash it). Runtime v11 call
// sites must strip `event_id` first — the v11 wire form has no such
// field; it is the derived reference hash (absent at signing time).
export async function contentHashOf(eventObject) {
  const copy = { ...eventObject };
  delete copy.unsigned;
  delete copy.signatures;
  delete copy.signature;
  delete copy.hashes;
  return b64encodeStd(await sha256ofString(canonicalJson(copy)));
}

// signJson (appendices § Signing Details + spec example code
// hash_and_sign_event): strip signatures/unsigned, sign the canonical
// bytes, attach under signatures[signingName][keyId]. Mutates obj like
// the spec's sign_json (which pops signatures/unsigned and restores).
export async function signJson(obj, signingName, keyId, privateKey) {
  const signatures = obj.signatures ?? {};
  const unsigned = obj.unsigned;
  delete obj.signatures;
  delete obj.unsigned;
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(canonicalJson(obj)),
  );
  signatures[signingName] ??= {};
  signatures[signingName][keyId] = b64encodeStd(new Uint8Array(sig));
  obj.signatures = signatures;
  if (unsigned !== undefined) obj.unsigned = unsigned;
  return obj;
}

// Check a signature (appendices § "Checking for a Signature"): find
// signatures[entity][keyId], strip signatures+unsigned, verify.
export async function verifyJson(obj, entity, keyId, publicKey) {
  const sigB64 = obj?.signatures?.[entity]?.[keyId];
  if (typeof sigB64 !== 'string') return false;
  let sig;
  try {
    sig = b64decode(sigB64);
  } catch {
    return false;
  }
  const copy = { ...obj };
  delete copy.signatures;
  delete copy.unsigned;
  try {
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      sig,
      new TextEncoder().encode(canonicalJson(copy)),
    );
  } catch {
    return false;
  }
}

// PKCS#8 DER wrap for a 32-byte Ed25519 seed (for importing test-vector
// and stored keys into WebCrypto, which has no raw-seed import).
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

export async function importPrivateKeyFromSeed(seed32) {
  const der = new Uint8Array([...PKCS8_ED25519_PREFIX, ...seed32]);
  return await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
}

export async function importPrivateKeyFromPkcs8(derBytes) {
  return await crypto.subtle.importKey(
    'pkcs8',
    derBytes,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
}

export async function exportPrivateKeyPkcs8(privateKey) {
  return new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
}

export async function importPublicKeyFromRaw(raw32) {
  return await crypto.subtle.importKey(
    'raw',
    raw32,
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
}

export async function exportPublicKeyRaw(publicKey) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
}

export async function generateSigningKeypair() {
  return await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
}
