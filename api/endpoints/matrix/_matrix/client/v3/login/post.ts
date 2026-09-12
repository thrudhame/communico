import { parseJson } from '@pathfinder/pathfinder/body';
import { MatrixError } from '../../../../../../engine/matrix-error.ts';
import { issueToken, upsertDevice, verifyUserPassword } from '../../../../../../engine/tenant.ts';
import { SERVER_NAME } from '../../../../../../engine/config.ts';

export const auth = false;

// m.login.password (F1 step 18): argon2id verify against the tenant
// credentials; `identifier.type m.id.user` plus the legacy `user` shape
// (capture rows 1–2). Failures are 403 M_FORBIDDEN (never user-oracle
// details beyond the code).
export default async function (request: import('@pathfinder/pathfinder').PathfinderRequest) {
  const body = await parseJson(request) as Record<string, unknown>;
  if (body?.type !== 'm.login.password') {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'expected m.login.password');
  }
  const ident = body?.identifier as Record<string, unknown> | undefined;
  let rawUser: unknown;
  if (ident && typeof ident === 'object') {
    if (ident.type !== 'm.id.user') {
      throw new MatrixError(400, 'M_BAD_REQUEST', 'unsupported identifier type');
    }
    rawUser = ident.user;
  } else {
    rawUser = body?.user;
  }
  if (typeof rawUser !== 'string' || typeof body?.password !== 'string') {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'user + password required');
  }
  // Full MXID must name this server; bare localparts are accepted and
  // downcased (registration downcases too).
  let localpart: string;
  if (rawUser.startsWith('@')) {
    const rest = rawUser.slice(1);
    const colon = rest.lastIndexOf(':');
    if (colon < 0) throw new MatrixError(403, 'M_FORBIDDEN', 'invalid username or password');
    localpart = rest.slice(0, colon).toLowerCase();
    if (rest.slice(colon + 1) !== SERVER_NAME) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'invalid username or password');
    }
  } else {
    localpart = rawUser.toLowerCase();
  }
  if (!await verifyUserPassword(SERVER_NAME, localpart, body.password)) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'invalid username or password');
  }
  const deviceId: string = typeof body.device_id === 'string' && body.device_id.length > 0
    ? body.device_id
    : crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  // Login (re)creates the device row — the devices list reflects every
  // device that holds (or held) a token.
  await upsertDevice(
    SERVER_NAME,
    localpart,
    deviceId,
    typeof body.initial_device_display_name === 'string'
      ? body.initial_device_display_name
      : undefined,
  );
  const accessToken = await issueToken(SERVER_NAME, localpart, deviceId);
  return {
    user_id: `@${localpart}:${SERVER_NAME}`,
    access_token: accessToken,
    device_id: deviceId,
    home_server: SERVER_NAME,
  };
}
