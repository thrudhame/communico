import { MatrixError } from '#engine/matrix-error.ts';
import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { loadFilter } from '#engine/tenant/filters.ts';

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
    theApp().tenant,
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
