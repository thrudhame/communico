// Endpoint-owned envelopes. Parsing one of these is not PDU/signature/identity
// admission: the room/key owner still verifies the parsed records before use.
import { objectOf } from '#engine/net/json.ts';
import { protocol } from '#engine/net/upstream-error.ts';

export function sendVerdicts(raw: unknown): Record<string, { error?: string }> {
  const body = objectOf(raw, 'send-verdict');
  const pdus = objectOf(body.pdus, 'send-verdict');
  for (const value of Object.values(pdus)) {
    const verdict = objectOf(value, 'send-verdict');
    if (verdict.error !== undefined && typeof verdict.error !== 'string') {
      protocol('send-verdict', 'invalid PDU verdict');
    }
  }
  return pdus as Record<string, { error?: string }>;
}
