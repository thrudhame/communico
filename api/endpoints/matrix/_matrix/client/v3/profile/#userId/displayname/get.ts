import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId}/displayname — "Get the user's
// display name. This API may be used to fetch the user's own displayname
// or to query the name of other users; either locally or on remote
// homeservers." (spec v1.11, Profiles.) Public read; the key is omitted
// when unset ({} response).
export default async function (request: PathfinderRequest) {
  const userId = request.params.userId as string;
  const colon = userId.lastIndexOf(':');
  if (!userId.startsWith('@') || colon < 0 || userId.slice(colon + 1) !== serverName()) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  const profile = await getProfile(serverName(), userId.slice(1, colon));
  if (profile === null) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  return profile.displayname !== undefined ? { displayname: profile.displayname } : {};
}
