import { theApp } from '#engine/app.ts';
import { localpartOf, revokeAllTokens } from '#engine/tenant/auth.ts';

// POST /_matrix/client/v3/logout/all — invalidate all of the user's tokens.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const localpart = localpartOf(userId);
  await revokeAllTokens(theApp().tenant, localpart);
  return {};
}
