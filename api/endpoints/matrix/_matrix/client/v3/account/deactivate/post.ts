import { parseJson } from '@pathfinder/pathfinder/body';
import { theApp } from '#engine/app.ts';
import { deactivateAccount } from '#engine/client/account.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/tenant/uia.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { MatrixError } from '#engine/matrix-error.ts';

// POST /_matrix/client/v3/account/deactivate — "Deactivate the user's
// account, removing all ability for the user to login again. This API
// endpoint uses the User-Interactive Authentication API. An access token
// should be submitted to this endpoint if the client has an active
// session." (spec v1.11.) All tokens/devices/pushers are removed; a later
// login gets 403 M_USER_DEACTIVATED. id_server_unbind_result is a constant
// 'success' (no identity server in M2 scope).
export default async function (request: PathfinderRequest, context: Context) {
  let body: Record<string, unknown> = {};
  try {
    body = (await parseJson(request)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Error && e.name === 'ParseError') body = {};
    else throw e;
  }
  const caller = context.state.user as string;
  if (body.erase !== undefined && typeof body.erase !== 'boolean') {
    throw new MatrixError(400, 'M_BAD_JSON', 'erase must be a boolean');
  }
  await requireUia(theApp().tenant, {
    body,
    flows: PASSWORD_FLOWS,
    caller,
  });
  await deactivateAccount(localpartOf(caller), body.erase === true);
  return { id_server_unbind_result: 'success' };
}
