// Verify the authored PDU at its consumer, including the complete content hash
// and the room-version-specific signature/reference hash.
import { assert, assertEquals } from '@std/assert';
import { eventIdFor, redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import { contentHashOf, verifyJson } from '#engine/signing-primitives.js';
import { testRemoteServer } from '#tests/fixtures/signer.ts';

export async function assertAuthored(
  event: Pdu | Record<string, unknown>,
  version = '11',
  server = 'test',
): Promise<void> {
  const pdu = event as unknown as Record<string, unknown>;
  assertEquals(pdu.origin, server, 'authored origin is the signing server');
  const wire = { ...pdu };
  delete wire.event_id;
  assertEquals(
    (pdu.hashes as { sha256: string }).sha256,
    await contentHashOf(wire),
    'origin must be included before content hashing',
  );
  const redacted = redact(pdu, version);
  delete redacted.event_id;
  const keys = await testRemoteServer(server);
  assert(
    await verifyJson(redacted, server, keys.keyId, keys.kp.publicKey),
    'authored signature must verify',
  );
  if (pdu.event_id !== undefined) {
    assertEquals(pdu.event_id, await eventIdFor(pdu, version));
  }
}
