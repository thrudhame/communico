import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { putAccountData } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// PUT /_matrix/client/v3/user/{userId}/rooms/{roomId}/account_data/{type}
// — "Set some account data for the client on a given room. This config is
// only visible to the user that set the account data." (spec v1.11,
// Client Config.) Room id opaque in M2 (no membership check); self-only
// (403 otherwise); body must be a JSON object. Response: {}.
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
  const content = await parseJson(request);
  if (
    content === null || typeof content !== 'object' || Array.isArray(content)
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'account data content must be a JSON object',
    );
  }
  await putAccountData(
    serverName(),
    localpartOf(caller),
    request.params.roomId as string,
    request.params.type as string,
    content,
  );
  return {};
}
