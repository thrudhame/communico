import { userProfile } from '#engine/client/profile.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/profile/{userId}/avatar_url — spec v1.11.
// Public read; the key is omitted when unset ({} response). The
// remote lookup follows the shared held-member lookup policy.
export default async function (request: PathfinderRequest) {
  const profile = await userProfile(request.params.userId as string);
  return profile.avatar_url !== undefined
    ? { avatar_url: profile.avatar_url }
    : {};
}
