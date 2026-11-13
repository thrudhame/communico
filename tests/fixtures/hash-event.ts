// Independently encoded hash/signature material, not the local PDU producer.
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteServer } from '#tests/fixtures/remote.ts';

const standard = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export async function hashBytesOf(pdu: Pdu): Promise<string> {
  const {
    event_id: _id,
    unsigned: _unsigned,
    signatures: _signatures,
    hashes: _hashes,
    ...body
  } = pdu;
  return standard(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalJson(body)),
      ),
    ),
  );
}

export async function signWithHash(
  pdu: Pdu,
  server: RemoteServer,
  version: string,
  hash: string,
): Promise<Pdu> {
  const copy = structuredClone(pdu);
  delete copy.event_id;
  copy.hashes = { sha256: hash };
  copy.signatures = {};
  const signed = redact(copy as unknown as Record<string, unknown>, version);
  delete signed.signatures;
  delete signed.unsigned;
  const signature = await crypto.subtle.sign(
    'Ed25519',
    server.kp.privateKey,
    new TextEncoder().encode(canonicalJson(signed)),
  );
  copy.signatures = {
    [server.name]: { [server.keyId]: standard(new Uint8Array(signature)) },
  };
  copy.event_id = await eventIdFor(
    copy as unknown as Record<string, unknown>,
    version,
  );
  return copy;
}
