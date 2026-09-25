// GET /_matrix/key/v2/server — our own key document, re-signed on every
// call (spec v1.16, data/api/server-server/keys_server.yaml:38-56).
// Public: the /_matrix/key/ tree has no auth placement.
import {
  assertFederationEnabled,
  keyDocResponse,
} from '#engine/federation/keydoc.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';

export default async function () {
  assertFederationEnabled();
  return keyDocResponse(await ourKeyDocument());
}
