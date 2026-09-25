// GET /_matrix/key/v2/query/{serverName}?minimum_valid_until_ts= — the
// notary, answered from what we hold: the server's verbatim cached
// document with our signature added. Unknown server → {server_keys: []};
// no fetch on miss (unauthenticated endpoint — a fetch would be an
// amplifier). minimum_valid_until_ts is accepted and unused for this
// limited (narrowed) conformance claim.
// (spec v1.16, data/api/server-server/keys_query.yaml:19-54.)
import {
  assertFederationEnabled,
  keyDocResponse,
  notaryFromCache,
} from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const name = request.params.serverName as string;
  const doc = await notaryFromCache(name);
  return keyDocResponse({ server_keys: doc === null ? [] : [doc] });
}
