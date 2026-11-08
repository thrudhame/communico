import { lookupToken } from '#engine/tenant/auth.ts';
import { theApp } from '#engine/app.ts';

// GET /_matrix/client/v3/account/whoami — matrix-commander validates
// restored credentials with this on every authenticated invocation
// (capture: wire-observed; nio WhoamiResponse requires user_id,
// device_id optional). Unknown/missing tokens are proper 401s (F1).
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const token = context.state.token;
  const info = token ? await lookupToken(theApp().tenant, token) : null;
  return {
    user_id: context.state.user,
    device_id: info?.device_id ?? undefined,
  };
}
