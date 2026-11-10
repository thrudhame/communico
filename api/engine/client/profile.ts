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
import { getProfile } from '#engine/tenant/users.ts';
import { discoveryRequest } from '#engine/federation/discovery.ts';

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
      const fields = answer as Record<string, unknown>;
      profile = {};
      if (typeof fields.displayname === 'string') {
        profile.displayname = fields.displayname;
      }
      if (typeof fields.avatar_url === 'string') {
        profile.avatar_url = fields.avatar_url;
      }
    } else if (fed.enabled && fed.lookups === 'known') {
      profile = await remoteUserFromMembers(userId, app);
    }
  }
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  return profile;
}
