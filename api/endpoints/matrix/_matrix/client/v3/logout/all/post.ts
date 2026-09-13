import { serverName } from '#engine/config.ts';
import { revokeAllTokens } from '#engine/tenant.ts';

// POST /_matrix/client/v3/logout/all — invalidate all of the user's tokens.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const localpart = userId.slice(1, userId.lastIndexOf(':'));
  await revokeAllTokens(serverName(), localpart);
  return {};
}
