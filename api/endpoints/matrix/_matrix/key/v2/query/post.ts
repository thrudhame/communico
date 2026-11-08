import { theApp } from '#engine/app.ts';
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
  const requested = (body as Record<string, unknown>).server_keys;
  const app = theApp();
  const out: unknown[] = [];
  if (requested !== null && typeof requested === 'object') {
    for (const name of Object.keys(requested as Record<string, unknown>)) {
      const doc = await notaryFromCache(app.server, app.tenant.signer(), name);
      if (doc !== null) out.push(doc);
    }
  }
  return keyDocResponse({ server_keys: out });
}
