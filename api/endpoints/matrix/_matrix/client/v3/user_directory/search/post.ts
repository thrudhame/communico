import { MatrixError } from '#engine/matrix-error.ts';
import { searchUsers } from '#engine/user-directory.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/user_directory/search — the visible-user
// directory (spec v1.16 users.yaml; band C D6). search_term is required;
// limit defaults to 10; this folder is protected (20-auth.ts, spec's
// security block at users.yaml:41-43).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = (await parseJson(request)) as Record<string, unknown>;
  const term = body.search_term;
  if (typeof term !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'search_term is required');
  }
  const limit = typeof body.limit === 'number' && body.limit >= 0
    ? Math.trunc(body.limit)
    : 10;
  return await searchUsers(context.state.user as string, term, limit);
}
