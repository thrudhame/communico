import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant/users.ts';
import { theApp } from '#engine/app.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId}/displayname — spec v1.11.
// Public read; the key is omitted when unset ({} response). The
// remote lookup returns with federation serving (5b).
export default async function (request: PathfinderRequest) {
  const userId = request.params.userId as string;
  const colon = userId.lastIndexOf(':');
  const local = userId.startsWith('@') && colon > 0 &&
    userId.slice(colon + 1) === serverName();
  let profile: Record<string, unknown> | null = null;
  if (local) {
    profile = await getProfile(theApp().tenant, userId.slice(1, colon));
  }
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile.displayname !== undefined
    ? { displayname: profile.displayname }
    : {};
}
