import { parseJson } from '@pathfinder/pathfinder/body';
import { SERVER_NAME } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  checkLocalpart,
  completeUiaStages,
  createUiaSession,
  dropUiaSession,
  ensureTenant,
  getUiaSession,
  registerUser,
} from '#engine/tenant.ts';
import { withDb } from '#engine/db.ts';


const FLOWS = [{ stages: ['m.login.dummy'] }];

// POST /_matrix/client/v3/register — UIA (F1 step 17). Complement's
// contract (read off apidoc_register_test.go, not assumed):
// - bodies are validated BEFORE UIA: bad-grammar username → 400
//   M_INVALID_USERNAME and taken username → 400 M_USER_IN_USE, even with
//   no session at all;
// - otherwise sessions are REQUIRED: unknown/absent session → 401 +
//   fresh session (never one-shot completion), known session + completed
//   stages → finalize.
// Accepted completing stages: m.login.dummy, and m.login.password when a
// new password is present (at registration both prove the same thing).
// honoring: inhibit_login, device_id, initial_device_display_name.
export default async function (request: import('@pathfinder/pathfinder').PathfinderRequest) {
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
    const { dbName } = await ensureTenant(SERVER_NAME);
    const taken = await withDb(dbName, async (c: import('pg').Client) => {
      const r = await c.query('SELECT localpart FROM users WHERE localpart = $1;', [localpart]);
      return r.rows.length > 0;
    });
    if (taken) throw new MatrixError(400, 'M_USER_IN_USE', 'user in use: ' + localpart);
  }

  // 2. UIA session (required, never one-shot).
  const authn = (body.auth ?? {}) as Record<string, unknown>;
  const sessionId = body.session ?? authn.session;
  const session = typeof sessionId === 'string'
    ? await getUiaSession(SERVER_NAME, sessionId)
    : null;
  if (!session) {
    const fresh = await createUiaSession(SERVER_NAME, FLOWS);
    throw new MatrixError(401, 'M_UNAUTHORIZED', 'registration incomplete', {
      flows: fresh.flows,
      session: fresh.session,
    });
  }

  const newly: string[] = [];
  if (authn.type === 'm.login.dummy') newly.push('m.login.dummy');
  if (authn.type === 'm.login.password' && typeof body.password === 'string') {
    newly.push('m.login.password');
  }
  const updated = newly.length > 0
    ? await completeUiaStages(SERVER_NAME, session.session, newly)
    : session;

  const done = updated.completed.includes('m.login.dummy') ||
    updated.completed.includes('m.login.password');
  if (!done) {
    throw new MatrixError(401, 'M_UNAUTHORIZED', 'registration incomplete', {
      flows: updated.flows,
      session: updated.session,
    });
  }

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
  const result = await registerUser(SERVER_NAME, {
    localpart,
    password: body.password,
    deviceId: typeof body.device_id === 'string' ? body.device_id : undefined,
    displayName: typeof body.initial_device_display_name === 'string'
      ? body.initial_device_display_name
      : undefined,
    accessToken: inhibit ? null : undefined,
  });
  await dropUiaSession(SERVER_NAME, session.session);
  const out: Record<string, unknown> = {
    user_id: result.user_id,
    device_id: result.device_id,
    home_server: result.home_server,
  };
  if (result.access_token !== undefined) out.access_token = result.access_token;
  return out;
}
