import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { checkLocalpart, ensureTenant, registerUser } from '#engine/tenant.ts';
import { DUMMY_FLOWS, requireUia } from '#engine/uia.ts';
import { withDb } from '#engine/db.ts';

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
  let localpart: string | null = null;
  if (body.username !== undefined) {
    localpart = checkLocalpart(body.username);
    const { dbName } = await ensureTenant(serverName());
    const taken = await withDb(dbName, async (c: import('pg').Client) => {
      const r = await c.query(
        'SELECT localpart FROM users WHERE localpart = $1;',
        [localpart],
      );
      return r.rows.length > 0;
    });
    if (taken) {
      throw new MatrixError(400, 'M_USER_IN_USE', 'user in use: ' + localpart);
    }
  }

  // 2. UIA: dummy flow via the shared helper (sessions + completion).
  await requireUia({
    serverName: serverName(),
    body,
    flows: DUMMY_FLOWS,
  });

  // Finalize: username was grammar-checked pre-UIA (localpart is set);
  // missing username/password here is a 400 (the UIA dance always
  // carries them in Complement's flows).
  if (localpart === null) {
    throw new MatrixError(400, 'M_INVALID_USERNAME', 'username required');
  }
  if (typeof body.password !== 'string' || body.password.length === 0) {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'password required');
  }
  const inhibit = body.inhibit_login === true;
  const result = await registerUser(serverName(), {
    localpart,
    password: body.password,
    deviceId: typeof body.device_id === 'string' ? body.device_id : undefined,
    displayName: typeof body.initial_device_display_name === 'string'
      ? body.initial_device_display_name
      : undefined,
    accessToken: inhibit ? null : undefined,
  });
  const out: Record<string, unknown> = {
    user_id: result.user_id,
    device_id: result.device_id,
    home_server: result.home_server,
  };
  if (result.access_token !== undefined) out.access_token = result.access_token;
  return out;
}
