import { userProfile } from '#engine/client/profile.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId} — "Get the combined profile
// information for this user. This API may be used to fetch the user's own
// profile information or other users; either locally or on remote
// homeservers. This API may return keys which are not limited to
// `displayname` or `avatar_url`." (spec v1.11, Profiles.) Public read;
// remote profiles follow the shared held-member lookup policy.
export default async function (request: PathfinderRequest) {
  return await userProfile(request.params.userId as string);
}
