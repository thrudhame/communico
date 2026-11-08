// doltgres query/directory: local alias validation, then the shared directory.
import { MatrixError } from '#engine/matrix-error.ts';
import { aliasIsLocal, resolveAlias } from '#engine/client/directory.ts';
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
