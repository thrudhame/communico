// GET /_matrix/federation/v1/query/profile?user_id=... — "queries a
// profile" (query.yaml:109-203). Auth: the folder's 20-auth.ts. Local
// user → {displayname?, avatar_url?} (field filter); non-local domain and
// malformed ids → 400 M_INVALID_PARAM; unknown local user → 404
// M_NOT_FOUND.
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const userId = request.query.get('user_id');
  const colon = userId !== null ? userId.lastIndexOf(':') : -1;
  if (
    userId === null || !userId.startsWith('@') || colon < 0 ||
    userId.slice(colon + 1) !== serverName()
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid user id');
  }
  const profile = await getProfile(serverName(), userId.slice(1, colon));
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'no such user');
  }
  const field = request.query.get('field');
  if (field === 'displayname') {
    const name = (profile as Record<string, unknown>).displayname;
    return { displayname: name !== undefined ? name : null };
  }
  if (field === 'avatar_url') {
    const url = (profile as Record<string, unknown>).avatar_url;
    return { avatar_url: url !== undefined ? url : null };
  }
  return profile;
}
