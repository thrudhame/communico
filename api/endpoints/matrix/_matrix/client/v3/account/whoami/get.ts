import { lookupToken } from '../../../../../../../engine/tenant.ts';
import { SERVER_NAME } from '../../../../../../../engine/config.ts';

// GET /_matrix/client/v3/account/whoami — matrix-commander validates
// restored credentials with this on every authenticated invocation
// (capture: wire-observed; nio WhoamiResponse requires user_id,
// device_id optional). Unknown/missing tokens are proper 401s (F1).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const token = context.state.token;
  const info = token ? await lookupToken(SERVER_NAME, token) : null;
  return {
    user_id: context.state.user,
    device_id: info?.device_id ?? undefined,
  };
}
