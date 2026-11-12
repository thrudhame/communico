import { parseJson } from '@pathfinder/pathfinder/body';
import { MatrixError } from '#engine/matrix-error.ts';
import { loginUser } from '#engine/tenant/users.ts';
import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { splitId } from '#engine/ids.ts';
import { ensurePresenceRow } from '#engine/server/ephemeral.ts';
import { decodeLoginRequest } from '#engine/tenant/session-request.ts';

// m.login.password (F1 step 18): argon2id verify against the tenant
// credentials; `identifier.type m.id.user` plus the legacy `user` shape
// (capture rows 1–2). Failures are 403 M_FORBIDDEN (never user-oracle
// details beyond the code).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
) {
  const decoded = decodeLoginRequest(await parseJson(request));
  const rawUser = decoded.user;
  // Full MXID must name this server; bare localparts are accepted and
  // downcased (registration downcases too).
  let localpart: string;
  if (rawUser.startsWith('@')) {
    const parts = splitId(rawUser);
    if (parts.server === null) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'invalid username or password');
    }
    localpart = parts.localpart.toLowerCase();
    if (parts.server !== serverName()) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'invalid username or password');
    }
  } else {
    localpart = rawUser.toLowerCase();
  }
  const deviceId: string =
    decoded.deviceId !== undefined && decoded.deviceId.length > 0
      ? decoded.deviceId
      : crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const session = await loginUser(theApp().tenant, {
    localpart,
    deviceId,
    password: decoded.password,
    displayName: decoded.displayName,
    refresh: decoded.refresh,
  });
  // Band C (D8): refresh_token: true asks for the refresh flow
  // (login.yaml:158-161) — the access token then carries an
  // (informational, never enforced) expiry and a refresh token is issued.
  await ensurePresenceRow(theApp().server, `@${localpart}:${serverName()}`);
  const result: Record<string, unknown> = {
    user_id: `@${localpart}:${serverName()}`,
    access_token: session.accessToken,
    device_id: deviceId,
    home_server: serverName(),
  };
  if (session.refreshToken !== undefined) {
    result.expires_in_ms = session.expiresInMs;
    result.refresh_token = session.refreshToken;
  }
  return result;
}
