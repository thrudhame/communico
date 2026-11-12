import { parseJson } from '@pathfinder/pathfinder/body';
import { theApp } from '#engine/app.ts';
import { decodePasswordRequest } from '#engine/tenant/session-request.ts';
import { changePassword } from '#engine/tenant/users.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/tenant/uia.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// POST /_matrix/client/v3/account/password — "Changes the password for an
// account on this homeserver. This API endpoint uses the User-Interactive
// Authentication API to ensure the user changing the password is actually
// the owner of the account. … The homeserver SHOULD NOT revoke the access
// token provided in the request. Whether other access tokens for the user
// are revoked depends on the request parameters." (spec v1.11.)
// Body: {new_password: string, logout_devices?: boolean = true, auth?}.
export default async function (request: PathfinderRequest, context: Context) {
  const { body, password, logoutDevices } = decodePasswordRequest(
    await parseJson(request),
  );
  const caller = context.state.user as string;
  await requireUia(theApp().tenant, {
    body,
    flows: PASSWORD_FLOWS,
    caller,
  });
  await changePassword(
    theApp().tenant,
    localpartOf(caller),
    password,
    {
      keepToken: context.state.token,
      logoutDevices,
    },
  );
  return {};
}
