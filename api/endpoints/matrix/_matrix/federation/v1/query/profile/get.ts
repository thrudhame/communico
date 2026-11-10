// doltgres query/profile: local profile, field filter, 400 domain/404 unknown.
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getPublicProfile } from '#engine/tenant/profiles.ts';
import { theApp } from '#engine/app.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { splitId } from '#engine/ids.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const userId = request.query.get('user_id');
  const parts = userId === null ? null : splitId(userId);
  if (
    userId === null || !userId.startsWith('@') || parts === null ||
    parts.server === null || parts.server !== serverName()
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid user id');
  }
  const profile = await getPublicProfile(theApp().tenant, parts.localpart);
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'no such user');
  }
  const field = request.query.get('field');
  if (field === 'displayname') {
    return {
      displayname: profile.displayname === undefined
        ? null
        : profile.displayname,
    };
  }
  if (field === 'avatar_url') {
    return {
      avatar_url: profile.avatar_url === undefined ? null : profile.avatar_url,
    };
  }
  return profile;
}
