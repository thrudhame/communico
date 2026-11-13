import { MatrixError } from '#engine/matrix-error.ts';
import { searchUsers } from '#engine/client/directory.ts';
import { parseJson } from '#engine/operation-body.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = await parseJson(request) as Record<string, unknown>;
  if (typeof body.search_term !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'search_term is required');
  }
  return await searchUsers(
    context.state.user as string,
    body.search_term,
    typeof body.limit === 'number' && body.limit >= 0
      ? Math.trunc(body.limit)
      : 10,
  );
}
