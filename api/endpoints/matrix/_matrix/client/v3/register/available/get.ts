import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { checkLocalpart, isRegistered } from '#engine/tenant/users.ts';

// GET /_matrix/client/v3/register/available?username= — Complement
// 01register subtests: {available: true}, or 400 M_USER_IN_USE /
// M_INVALID_USERNAME.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
) {
  const username = request.query.get('username');
  const localpart = checkLocalpart(username);
  const taken = await isRegistered(theApp().tenant, localpart);
  if (taken) throw new MatrixError(400, 'M_USER_IN_USE', 'user in use');
  return { available: true };
}
