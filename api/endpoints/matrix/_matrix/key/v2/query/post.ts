import { theApp } from '#engine/app.ts';
import {
  assertFederationEnabled,
  keyDocResponse,
  notaryDocumentsFromCache,
} from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { notaryRequests } from '#engine/federation/notary-request.ts';
import { parseJson } from '#engine/operation-body.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  let body: unknown;
  try {
    body = await parseJson(request);
  } catch {
    throw new MatrixError(400, 'M_BAD_JSON', 'body is not valid JSON');
  }
  const requested = notaryRequests(body);
  const app = theApp();
  const out = await notaryDocumentsFromCache(
    app.server,
    app.tenant.signer(),
    requested,
  );
  return keyDocResponse({ server_keys: out });
}
