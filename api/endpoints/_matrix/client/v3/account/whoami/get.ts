import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { SERVER_DB, withDb } from '../../../../../../engine/db.ts';

// GET /_matrix/client/v3/account/whoami — matrix-commander validates
// restored credentials with this on every authenticated invocation
// (capture: wire-observed; nio WhoamiResponse requires user_id,
// device_id optional).
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    const header = request.headers.get('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1] ?? request.search.get('access_token');
    if (!token) throw new Error('M_MISSING_TOKEN');
    return await withDb(SERVER_DB, async (c) => {
      const r = await c.query(
        'SELECT user_id, device_id FROM access_tokens WHERE token = $1;',
        [token],
      );
      if (r.rows.length === 0) throw new Error('M_UNKNOWN_TOKEN');
      return [null, {
        user_id: String(r.rows[0].user_id),
        device_id: r.rows[0].device_id == null
          ? undefined
          : String(r.rows[0].device_id),
      }];
    });
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
