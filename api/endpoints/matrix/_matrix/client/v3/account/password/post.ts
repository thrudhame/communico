import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { changePassword } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/uia.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// POST /_matrix/client/v3/account/password — "Changes the password for an
// account on this homeserver. This API endpoint uses the User-Interactive
// Authentication API to ensure the user changing the password is actually
// the owner of the account. … The homeserver SHOULD NOT revoke the access
// token provided in the request. Whether other access tokens for the user
// are revoked depends on the request parameters." (spec v1.11.)
// Body: {new_password: string, logout_devices?: boolean = true, auth?}.
export default async function (request: PathfinderRequest, context: Context) {
  const body = await parseJson(request) as Record<string, unknown>;
  if (typeof body.new_password !== 'string' || body.new_password.length === 0) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'new_password required');
  }
  const caller = context.state.user as string;
  await requireUia({
    serverName: serverName(),
    body,
    flows: PASSWORD_FLOWS,
    caller,
  });
  const logoutDevices = body.logout_devices === undefined
    ? true
    : body.logout_devices === true;
  await changePassword(serverName(), localpartOf(caller), body.new_password, {
    keepToken: context.state.token,
    logoutDevices,
  });
  return {};
}
