import { authorize } from '#engine/auth-context.ts';
import { queryDirectory } from '#engine/client/directory.ts';
import {
  decodeDirectoryRequest,
  directoryDestination,
} from '#engine/client/directory-request.ts';
import { parseJson } from '#engine/operation-body.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  await authorize(request);
  return await queryDirectory(
    decodeDirectoryRequest(request.query, await parseJson(request)),
    directoryDestination(request.query),
  );
}
