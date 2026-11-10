// One public profile policy for combined and per-field reads. Local profiles
// come from the tenant; remote lookup policy is explicit and shared by fields.
import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { splitId } from '#engine/ids.ts';
import {
  type Profile,
  remoteUserFromMembers,
} from '#engine/federation/query.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getPublicProfile } from '#engine/tenant/profiles.ts';
import { discoveryRequest } from '#engine/federation/discovery.ts';
import { authorize } from '#engine/auth-context.ts';
import { localpartOf } from '#engine/ids.ts';
import { setProfileField } from '#engine/tenant/profiles.ts';
import { propagateProfile } from '#engine/client/membership.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export async function deleteProfileField(
  request: PathfinderRequest,
  key: string,
) {
  const caller = await authorize(request);
  const userId = request.params.userId as string;
  if (caller !== userId) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'cannot change another user profile',
    );
  }
  await setProfileField(theApp().tenant, localpartOf(userId), key, undefined);
  if (key === 'displayname' || key === 'avatar_url') {
    await propagateProfile(userId, key);
  }
  return {};
}

export async function userProfile(userId: string): Promise<Profile> {
  const app = theApp();
  const parts = splitId(userId);
  let profile: Profile | null = null;
  if (
    userId.startsWith('@') && parts.server !== null &&
    parts.server === serverName()
  ) {
    profile = await getPublicProfile(app.tenant, parts.localpart);
  } else {
    const fed = config().federation;
    if (
      fed.enabled && fed.lookups === 'all' && userId.startsWith('@') &&
      parts.localpart.length > 0 && parts.server !== null &&
      parts.server.length > 0
    ) {
      const answer = await discoveryRequest(app.server, app.tenant.signer(), {
        destination: parts.server,
        path: '/_matrix/federation/v1/query/profile?user_id=' +
          encodeURIComponent(userId),
      });
      if (
        answer === null || typeof answer !== 'object' || Array.isArray(answer)
      ) {
        throw new MatrixError(502, 'M_UNKNOWN', 'invalid remote profile');
      }
      profile = { ...answer } as Profile;
      if (typeof profile.displayname !== 'string') delete profile.displayname;
      if (typeof profile.avatar_url !== 'string') delete profile.avatar_url;
    } else if (fed.enabled && fed.lookups === 'known') {
      profile = await remoteUserFromMembers(userId, app);
    }
  }
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile;
}
