import type { TApiComponentRequest } from '@communico/api/interfaces';
import { SERVER_DB, withDb } from './db.ts';

// Static dev-token auth: token from `Authorization: Bearer <token>` OR
// the `?access_token=` query param (matrix-nio's observed mechanism —
// capture conclusion 2). Looks the token up in access_tokens on the
// server DB, returns the user_id. Throws on missing/unknown token.
export async function authorize(
  request: TApiComponentRequest,
): Promise<string> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  const token = match?.[1] ?? request.search.get('access_token');
  if (!token) throw new Error('M_MISSING_TOKEN: no Bearer token');
  return await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT user_id FROM access_tokens WHERE token = $1;',
      [token],
    );
    if (r.rows.length === 0) {
      throw new Error('M_UNKNOWN_TOKEN: token not recognized');
    }
    return String(r.rows[0].user_id);
  });
}
