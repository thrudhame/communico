import { authorize } from '#engine/auth-context.ts';
import { publicRooms } from '#engine/client/directory.ts';
import { decodeDirectoryRequest } from '#engine/client/directory-request.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  await authorize(request);
  return await publicRooms(
    decodeDirectoryRequest(request.query, await parseJson(request)),
  );
}
