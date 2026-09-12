import { SERVER_NAME } from '#engine/config.ts';
import { revokeToken } from '#engine/tenant.ts';

// POST /_matrix/client/v3/logout — invalidate the calling token.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  await revokeToken(SERVER_NAME, context.state.token as string);
  return {};
}
