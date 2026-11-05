import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant/users.ts';
import { theApp } from '#engine/app.ts';
import { splitId } from '#engine/ids.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId}/displayname — spec v1.11.
// Public read; the key is omitted when unset ({} response). The
// remote lookup returns with federation serving (5b).
export default async function (request: PathfinderRequest) {
  const userId = request.params.userId as string;
  const parts = splitId(userId);
  const local = userId.startsWith('@') && parts.server !== null &&
    parts.server === serverName();
  let profile: Record<string, unknown> | null = null;
  if (local) {
    profile = await getProfile(theApp().tenant, parts.localpart);
  }
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile.displayname !== undefined
    ? { displayname: profile.displayname }
    : {};
}
