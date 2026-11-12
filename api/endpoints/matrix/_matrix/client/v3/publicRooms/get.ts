import { publicRooms } from '#engine/client/directory.ts';
import { decodeDirectoryRequest } from '#engine/client/directory-request.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  return await publicRooms(decodeDirectoryRequest(request.query));
}
