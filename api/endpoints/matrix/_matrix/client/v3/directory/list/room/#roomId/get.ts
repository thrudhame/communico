import { getVisibility } from '#engine/client/directory.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  return await getVisibility(request.params.roomId as string);
}
