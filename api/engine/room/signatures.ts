// Verified signature evidence is prepared outside room locks. Immutable full
// material is captured before hash-mismatch redaction can discard content.
import { canonicalJson } from '#engine/canonical.ts';
import type { Pdu } from '#engine/pdu.ts';
import { b64encodeStd, matrixBase64 } from '#engine/signing-primitives.js';
import { getRulebook } from '#engine/rulebook/index.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import type { KeyResolver } from './deps.ts';
import { verify } from './verify.ts';

export const EVENT_SIGNATURES_SQL = `
CREATE TABLE event_signatures(
  event TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  signatures TEXT NOT NULL
);
`;

export function eventMaterial(pdu: Pdu): string {
  const { signatures: _s, unsigned: _u, ...material } = pdu;
  void _s, _u;
  return canonicalJson(material);
}

const verifiedEvidence: unique symbol = Symbol('verified event signatures');
export type SignatureEvidence = {
  readonly [verifiedEvidence]: true;
  readonly eventId: string;
  readonly material: string;
  readonly signatures: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
};

export async function prepareEventSignatures(
  raw: Pdu,
  roomVersion: string,
  keys: KeyResolver,
  options: Parameters<typeof verify>[3] = {},
) {
  const material = eventMaterial(raw);
  const verified = await verify(raw, roomVersion, keys, options);
  const signatures: Record<string, Readonly<Record<string, string>>> = {};
  for (
    const [server, entries] of Object.entries(verified.pdu.signatures ?? {})
  ) {
    const accepted: Record<string, string> = {};
    for (const [keyId, signature] of Object.entries(entries)) {
      options.signal?.throwIfAborted();
      if (
        !await keys.verifyEventSignature({
          server,
          keyId,
          pdu: verified.pdu,
          roomVersion,
          minValidUntilMs: getRulebook(roomVersion).spec.enforceKeyValidity
            ? Number(verified.pdu.origin_server_ts)
            : 0,
          signal: options.signal,
        })
      ) {
        throw new UpstreamError('validation', {
          phase: 'event',
          reason: 'M_UNAUTHORIZED: additional PDU signature invalid',
        });
      }
      accepted[keyId] = b64encodeStd(matrixBase64(signature, 64));
    }
    signatures[server] = Object.freeze(accepted);
  }
  const evidence: SignatureEvidence = Object.freeze({
    [verifiedEvidence]: true as const,
    eventId: verified.eventId,
    material,
    signatures: Object.freeze(signatures),
  });
  return { ...verified, evidence };
}
