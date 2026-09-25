// POST /_matrix/key/v2/query — the notary for several servers in one
// call. Body {server_keys: {name: {keyId: {minimum_valid_until_ts}}}} →
// {server_keys: [...]}, each answered from cache (no fetch on miss).
// (spec v1.16, data/api/server-server/keys_query.yaml:55-119.)
import {
  assertFederationEnabled,
  keyDocResponse,
  notaryFromCache,
} from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  let body: unknown;
  try {
    body = await parseJson(request);
  } catch {
    throw new MatrixError(400, 'M_BAD_JSON', 'body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'body is not an object');
  }
  const o = body as Record<string, unknown>;
  const requested = o.server_keys;
  const out: unknown[] = [];
  if (requested !== null && typeof requested === 'object') {
    for (const name of Object.keys(requested as Record<string, unknown>)) {
      const doc = await notaryFromCache(name);
      if (doc !== null) out.push(doc);
    }
  }
  return keyDocResponse({ server_keys: out });
}
