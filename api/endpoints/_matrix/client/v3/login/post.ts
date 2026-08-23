import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { SERVER_DB, withDb } from '../../../../../engine/db.ts';

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// m.login.password auth (no token required). Body accepted in both nio
// (`identifier.user`) and legacy (`user`) shapes — capture rows 1–2.
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    const body = await request.body.json();
    const rawUser: unknown = body?.identifier?.user ?? body?.user;
    if (
      body?.type !== 'm.login.password' || typeof rawUser !== 'string' ||
      typeof body?.password !== 'string'
    ) {
      throw new Error('M_BAD_REQUEST: expected m.login.password with user + password');
    }
    const userId = rawUser.startsWith('@')
      ? rawUser
      : `@${rawUser}:localhost`;
    const pwHash = await sha256hex(body.password);

    return await withDb(SERVER_DB, async (c) => {
      const r = await c.query(
        'SELECT user_id FROM users WHERE user_id = $1 AND password_hash = $2;',
        [userId, pwHash],
      );
      if (r.rows.length === 0) {
        throw new Error('M_FORBIDDEN: invalid username or password');
      }
      const accessToken = crypto.randomUUID();
      const deviceId: string = typeof body.device_id === 'string' &&
          body.device_id.length > 0
        ? body.device_id
        : crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      await c.query(
        'INSERT INTO access_tokens (token, user_id, device_id) VALUES ($1, $2, $3);',
        [accessToken, userId, deviceId],
      );
      return [null, {
        user_id: userId,
        access_token: accessToken,
        device_id: deviceId,
        home_server: 'localhost',
      }];
    });
  } catch (e) {
    // framework turns this into a 400; nio treats any non-2xx as
    // LoginError and reports it cleanly (capture-verified behavior)
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
