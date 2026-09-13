import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getAccountData } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { PathfinderRequest, Context } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/user/{userId}/account_data/{type} — "Get some
// account data for the client. This config is only visible to the user
// that set the account data." (spec v1.11, Client Config.) "Users may
// only view the account data for their own account" — another user is
// 403 M_FORBIDDEN; unset data is 404 M_NOT_FOUND. The response is the
// content object itself.
export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'account data is private to its owner');
  }
  const content = await getAccountData(
    serverName(),
    localpartOf(caller),
    '',
    request.params.type as string,
  );
  if (content === null) throw new MatrixError(404, 'M_NOT_FOUND', 'account data not found');
  return content;
}
