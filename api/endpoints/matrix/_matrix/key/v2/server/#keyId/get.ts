// GET /_matrix/key/v2/server/{keyId} — DEPRECATED. The path parameter was
// removed from the spec in v1.6 (changelog/v1.6.md:46); the answer is the
// same document. Complement's fake server serves it
// (federation/handle.go:383-420) — kept for the harness.
import {
  assertFederationEnabled,
  keyDocResponse,
} from '#engine/federation/keydoc.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';

export default async function () {
  assertFederationEnabled();
  return keyDocResponse(await ourKeyDocument());
}
