// GET /_matrix/federation/v1/query/directory?room_alias=... — "queries a
// directory alias" (query.yaml:42-108). Auth: the folder's 20-auth.ts.
// Local alias → {room_id, servers: [ours]}; unknown → 404; a non-local
// domain → 400.
import { MatrixError } from '#engine/matrix-error.ts';
import { aliasIsLocal, resolveAlias } from '#engine/aliases.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const alias = request.query.get('room_alias');
  if (alias === null || !aliasIsLocal(alias)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid alias');
  }
  return await resolveAlias(alias);
}
