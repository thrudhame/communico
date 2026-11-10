import { userProfile } from '#engine/client/profile.ts';
import { checkProfileKey } from '#engine/tenant/profiles.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  const key = request.params.keyName as string;
  checkProfileKey(key);
  const profile = await userProfile(request.params.userId as string);
  if (!Object.hasOwn(profile, key)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'profile field not found');
  }
  return { [key]: profile[key] };
}
