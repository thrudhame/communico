import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant/users.ts';
import { theApp } from '#engine/app.ts';
import { splitId } from '#engine/ids.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId} — "Get the combined profile
// information for this user. This API may be used to fetch the user's own
// profile information or other users; either locally or on remote
// homeservers. This API may return keys which are not limited to
// `displayname` or `avatar_url`." (spec v1.11, Profiles.) Public read;
// local users in 5a-1, remote lookup returns with federation serving (5b).
export default async function (request: PathfinderRequest) {
  const userId = request.params.userId as string;
  const parts = splitId(userId);
  const local = userId.startsWith('@') && parts.server !== null &&
    parts.server === serverName();
  if (!local) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  const profile = await getProfile(theApp().tenant, parts.localpart);
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile;
}
