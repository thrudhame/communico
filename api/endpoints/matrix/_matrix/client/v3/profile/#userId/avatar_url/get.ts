import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant.ts';
import { remoteUserFromMembers } from '#engine/federation/query.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId}/avatar_url — spec v1.11.
// Public read; the key is omitted when unset ({} response). The
// federation.lookups branch for non-local users (not a proxy).
export default async function (request: PathfinderRequest) {
  const userId = request.params.userId as string;
  const colon = userId.lastIndexOf(':');
  const local = userId.startsWith('@') && colon > 0 &&
    userId.slice(colon + 1) === serverName();
  let profile: Record<string, unknown> | null = null;
  if (!local) {
    const fed = config().federation;
    if (fed.enabled && fed.lookups === 'known') {
      profile = await remoteUserFromMembers(userId);
    }
  } else {
    profile = await getProfile(serverName(), userId.slice(1, colon));
  }
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile.avatar_url !== undefined
    ? { avatar_url: profile.avatar_url }
    : {};
}
