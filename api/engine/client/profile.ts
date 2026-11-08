// One public profile policy for combined and per-field reads. Local profiles
// come from the tenant; remote profiles from held membership only, as doltgres.
import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { splitId } from '#engine/ids.ts';
import {
  type Profile,
  remoteUserFromMembers,
} from '#engine/federation/query.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getProfile } from '#engine/tenant/users.ts';

export async function userProfile(userId: string): Promise<Profile> {
  const app = theApp();
  const parts = splitId(userId);
  let profile: Profile | null = null;
  if (
    userId.startsWith('@') && parts.server !== null &&
    parts.server === serverName()
  ) {
    profile = await getProfile(app.tenant, parts.localpart);
  } else {
    const fed = config().federation;
    if (fed.enabled && fed.lookups === 'known') {
      profile = await remoteUserFromMembers(userId, app);
    }
  }
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile;
}
