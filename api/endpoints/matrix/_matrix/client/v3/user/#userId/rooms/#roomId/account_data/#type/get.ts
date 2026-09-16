import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getAccountData } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/user/{userId}/rooms/{roomId}/account_data/{type}
// — "Get some account data for the client on a given room. This config is
// only visible to the user that set the account data." (spec v1.11,
// Client Config.) "The account data may be either global or scoped to a
// particular room. There is no inheritance mechanism here." The room id is
// opaque in M2 (no membership check — room endpoints are M4); self-only,
// unset → 404 M_NOT_FOUND, response is the content object itself.
export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'account data is private to its owner',
    );
  }
  const content = await getAccountData(
    serverName(),
    localpartOf(caller),
    request.params.roomId as string,
    request.params.type as string,
  );
  if (content === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'account data not found');
  }
  return content;
}
