import { MatrixError } from '#engine/matrix-error.ts';
import { serverName } from '#engine/config.ts';
import { localpartOf } from '#engine/auth.ts';
import { loadFilter } from '#engine/filters.ts';

// GET /_matrix/client/v3/user/#userId/filter/#filterId — the stored
// filter document verbatim (own user only; 404 when unknown).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  if (request.params.userId !== userId) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'filters are per-user');
  }
  const doc = await loadFilter(
    serverName(),
    localpartOf(userId),
    request.params.filterId as string,
  );
  if (doc === null) {
    throw new MatrixError(
      404,
      'M_NOT_FOUND',
      'unknown filter: ' + request.params.filterId,
    );
  }
  return doc;
}
