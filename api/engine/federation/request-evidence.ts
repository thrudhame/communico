// Protected original admission evidence. Reconciliation verifies the remote
// signature at the authenticated cut, never the facade's assertion of origin
// and never a fresh request against today's possibly expired remote key.
import { Buffer } from 'node:buffer';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  b32decode,
  b64encodeStd,
  exportPublicKeyRaw,
  importPublicKeyFromRaw,
  isKeyName,
  matrixBase64,
} from '#engine/signing-primitives.js';
import { type KeyDoc, type KeyStore, validatedKeyDocument } from './keys.ts';
import { requestCanonical, type SignedRequest } from './request-signature.ts';
import { parseXMatrixHeaders } from './xmatrix.ts';

export type RequestEvidence = {
  version: 1;
  origin: string;
  destination: string;
  admitted: number;
  keyId: string;
  key: string;
  request: { method: string; uri: string; authorization: string; body: string };
  acquisition: { doc: KeyDoc; fetched: number; until: number } | null;
};

function unavailable(): never {
  throw new MatrixError(
    503,
    'M_UNAVAILABLE',
    'request key evidence changed during admission',
  );
}
function invalid(): never {
  throw new MatrixError(400, 'M_BAD_JSON', 'invalid retained request evidence');
}
function material(raw: string): string {
  return b64encodeStd(matrixBase64(raw, 32));
}

export async function captureRequestEvidence(
  keys: Pick<KeyStore, 'listServerKeys'>,
  destination: string,
  request: SignedRequest,
  verified: { origin: string; keyId: string; publicKey: CryptoKey },
): Promise<RequestEvidence> {
  const key = b64encodeStd(await exportPublicKeyRaw(verified.publicKey));
  let acquisition: RequestEvidence['acquisition'] = null;
  if (isKeyName(verified.origin)) {
    if (
      verified.keyId !== 'ed25519:0' ||
      b64encodeStd(b32decode(verified.origin)!) !== key
    ) unavailable();
  } else {
    const [held] = await keys.listServerKeys(verified.origin);
    if (!held?.doc) unavailable();
    const doc = await validatedKeyDocument(
      verified.origin,
      JSON.parse(held.doc.key_json),
    );
    const row = held.rows.find((r) =>
      r.key_id === verified.keyId && r.expired_ts === null
    );
    if (
      !row || material(row.pubkey_b64) !== key ||
      !doc.verify_keys[verified.keyId] ||
      material(doc.verify_keys[verified.keyId].key) !== key
    ) unavailable();
    acquisition = {
      doc,
      fetched: held.doc.fetched_ms,
      until: Math.min(
        row.valid_until_ts,
        doc.valid_until_ts,
        held.doc.fetched_ms + 7 * 86400_000,
      ),
    };
  }
  const evidence: RequestEvidence = {
    version: 1,
    origin: verified.origin,
    destination,
    admitted: Date.now(),
    keyId: verified.keyId,
    key,
    request: {
      method: request.method,
      uri: request.uri,
      authorization: request.authorization === null
        ? ''
        : request.authorization,
      body: Buffer.from(request.body).toString('base64'),
    },
    acquisition,
  };
  if (
    acquisition &&
    (acquisition.fetched > evidence.admitted ||
      acquisition.until < evidence.admitted)
  ) unavailable();
  // Check the resulting immutable proof itself before letting its owner stage it.
  await verifyRequestEvidence(evidence, destination);
  return evidence;
}

export async function verifyRequestEvidence(
  raw: unknown,
  destination: string,
): Promise<{ evidence: RequestEvidence; request: SignedRequest }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const v = raw as Partial<RequestEvidence>;
  if (
    v.version !== 1 || v.destination !== destination ||
    typeof v.origin !== 'string' || !v.origin ||
    typeof v.keyId !== 'string' || !/^ed25519:[A-Za-z0-9_]+$/.test(v.keyId) ||
    !Number.isSafeInteger(v.admitted) || Number(v.admitted) < 0 ||
    typeof v.key !== 'string' || !v.request ||
    typeof v.request !== 'object' ||
    !['method', 'uri', 'authorization', 'body'].every((k) =>
      typeof (v.request as unknown as Record<string, unknown>)[k] === 'string'
    ) ||
    !v.request.method || !v.request.uri.startsWith('/')
  ) invalid();
  const evidence = v as RequestEvidence;
  const body = Buffer.from(evidence.request.body, 'base64');
  if (body.toString('base64') !== evidence.request.body) invalid();
  let pub: CryptoKey;
  try {
    pub = await importPublicKeyFromRaw(matrixBase64(evidence.key, 32));
  } catch {
    invalid();
  }
  if (isKeyName(evidence.origin)) {
    if (
      evidence.acquisition !== null || evidence.keyId !== 'ed25519:0' ||
      b64encodeStd(b32decode(evidence.origin)!) !== evidence.key
    ) invalid();
  } else {
    const acquired = evidence.acquisition;
    if (
      !acquired || typeof acquired !== 'object' ||
      !Number.isSafeInteger(acquired.fetched) || acquired.fetched < 0 ||
      !Number.isSafeInteger(acquired.until) ||
      acquired.fetched > evidence.admitted ||
      acquired.until < evidence.admitted
    ) invalid();
    const doc = await validatedKeyDocument(evidence.origin, acquired.doc);
    if (
      !doc.verify_keys[evidence.keyId] ||
      material(doc.verify_keys[evidence.keyId].key) !==
        material(evidence.key) ||
      acquired.until >
        Math.min(doc.valid_until_ts, acquired.fetched + 7 * 86400_000)
    ) invalid();
  }
  const request: SignedRequest = { ...evidence.request, body };
  let canonical: string;
  try {
    canonical = requestCanonical(destination, request, evidence.origin);
  } catch {
    invalid();
  }
  for (
    const candidate of parseXMatrixHeaders([evidence.request.authorization])
  ) {
    if (
      candidate.origin !== evidence.origin ||
      candidate.key !== evidence.keyId ||
      (candidate.destination !== null && candidate.destination !== destination)
    ) continue;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      signature = matrixBase64(candidate.signature, 64);
    } catch {
      continue;
    }
    if (
      await crypto.subtle.verify(
        { name: 'Ed25519' },
        pub,
        signature,
        new TextEncoder().encode(canonical),
      )
    ) return { evidence, request };
  }
  invalid();
}
