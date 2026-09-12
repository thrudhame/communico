import { SERVER_NAME } from '../../../../../../../engine/config.ts';
import { MatrixError } from '../../../../../../../engine/matrix-error.ts';
import { checkLocalpart, ensureTenant } from '../../../../../../../engine/tenant.ts';
import { withDb } from '../../../../../../../engine/db.ts';

export const auth = false;

// GET /_matrix/client/v3/register/available?username= — Complement
// 01register subtests: {available: true}, or 400 M_USER_IN_USE /
// M_INVALID_USERNAME.
export default async function (request: import('@pathfinder/pathfinder').PathfinderRequest) {
  const username = request.query.get('username');
  const localpart = checkLocalpart(username);
  const { dbName } = await ensureTenant(SERVER_NAME);
  const taken = await withDb(dbName, async (c: import('pg').Client) => {
    const r = await c.query('SELECT localpart FROM users WHERE localpart = $1;', [localpart]);
    return r.rows.length > 0;
  });
  if (taken) throw new MatrixError(400, 'M_USER_IN_USE', 'user in use');
  return { available: true };
}
