import { deleteProfileField } from '#engine/client/profile.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
export default function (request: PathfinderRequest) {
  return deleteProfileField(request, 'avatar_url');
}
