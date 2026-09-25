import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant.ts';
import { remoteUserFromMembers } from '#engine/federation/query.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId} — "Get the combined profile
// information for this user. This API may be used to fetch the user's own
// profile information or other users; either locally or on remote
// homeservers. This API may return keys which are not limited to
// `displayname` or `avatar_url`." (spec v1.11, Profiles.) Public read —
// and for a non-local user the federation.lookups branch:
//   'known' (default) answers from member events in rooms we hold;
//   'none' 404s. Never an outbound request (not a proxy).
export default async function (request: PathfinderRequest) {
  const userId = request.params.userId as string;
  const colon = userId.lastIndexOf(':');
  const local = userId.startsWith('@') && colon > 0 &&
    userId.slice(colon + 1) === serverName();
  if (!local) {
    const fed = config().federation;
    if (fed.enabled && fed.lookups === 'known') {
      const remote = await remoteUserFromMembers(userId);
      if (remote !== null) return remote;
    }
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  const profile = await getProfile(serverName(), userId.slice(1, colon));
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile;
}
