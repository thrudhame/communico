import { theApp } from '#engine/app.ts';
import { revokeToken } from '#engine/tenant/auth.ts';

// POST /_matrix/client/v3/logout — invalidate the calling token.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  await revokeToken(theApp().tenant, context.state.token as string);
  return {};
}
