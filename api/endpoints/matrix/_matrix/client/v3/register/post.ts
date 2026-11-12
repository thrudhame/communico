import { parseJson } from '@pathfinder/pathfinder/body';
import { MatrixError } from '#engine/matrix-error.ts';
import { isRegistered, registerUser } from '#engine/tenant/users.ts';
import { DUMMY_FLOWS, requireUia } from '#engine/tenant/uia.ts';
import { theApp } from '#engine/app.ts';
import { ensurePresenceRow } from '#engine/server/ephemeral.ts';
import { decodeRegistrationRequest } from '#engine/tenant/session-request.ts';

// POST /_matrix/client/v3/register — UIA (F1 step 17; M2: via the shared
// requireUia helper). Complement's contract (read off
// apidoc_register_test.go, not assumed):
// - bodies are validated BEFORE UIA: bad-grammar username → 400
//   M_INVALID_USERNAME and taken username → 400 M_USER_IN_USE, even with
//   no session at all;
// - otherwise the UIA 401 dance (flows/params/session; params rides the
//   401 body per spec v1.11) with the dummy flow, then finalize.
// honoring: inhibit_login, device_id, initial_device_display_name.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
) {
  let body: Record<string, unknown> = {};
  try {
    body = (await parseJson(request)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Error && e.name === 'ParseError') body = {};
    else throw e;
  }
  // 1. body validation first (Complement: "validate request bodies
  // before handling UIA").
  const decoded = decodeRegistrationRequest(body, request.query);
  const localpart = decoded.localpart;
  if (localpart !== undefined) {
    const taken = await isRegistered(theApp().tenant, localpart);
    if (taken) {
      throw new MatrixError(400, 'M_USER_IN_USE', 'user in use: ' + localpart);
    }
  }

  // 2. UIA: dummy flow via the shared helper (sessions + completion).
  await requireUia(theApp().tenant, {
    body,
    flows: DUMMY_FLOWS,
  });

  // The tenant allocates a localpart when the client omitted username.
  if (decoded.password === undefined || decoded.password.length === 0) {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'password required');
  }
  const result = await registerUser(theApp().tenant, {
    localpart,
    password: decoded.password,
    deviceId: decoded.deviceId,
    deviceDisplayName: decoded.displayName,
    accessToken: decoded.inhibit ? null : undefined,
  });
  await ensurePresenceRow(theApp().server, result.user_id);
  const out: Record<string, unknown> = {
    user_id: result.user_id,
    home_server: result.home_server,
  };
  if ('device_id' in result) out.device_id = result.device_id;
  if (result.access_token !== undefined) out.access_token = result.access_token;
  return out;
}
