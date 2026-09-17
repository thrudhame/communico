import { MatrixError } from '#engine/matrix-error.ts';
import { serverName } from '#engine/config.ts';
import { localpartOf } from '#engine/auth.ts';
import { storeFilter, validateFilterDocument } from '#engine/filters.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/user/#userId/filter — store a filter for the
// own user (403 otherwise); the document's shape is validated (400
// M_BAD_JSON when malformed); returns {filter_id}.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  if (request.params.userId !== userId) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'filters are per-user');
  }
  const body = await parseJson(request);
  validateFilterDocument(body);
  const filterId = await storeFilter(
    serverName(),
    localpartOf(userId),
    body,
  );
  return { filter_id: filterId };
}
