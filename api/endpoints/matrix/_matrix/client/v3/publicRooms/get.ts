import { queryDirectory } from '#engine/client/directory.ts';
import {
  decodeDirectoryRequest,
  directoryDestination,
} from '#engine/client/directory-request.ts';
import { authorize } from '#engine/auth-context.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const destination = directoryDestination(request.query);
  try {
    await authorize(request);
  } catch (error) {
    if (
      !(error instanceof MatrixError) || error.status !== 401 ||
      !config().directory.allowanonymous || destination !== undefined
    ) throw error;
  }
  return await queryDirectory(
    decodeDirectoryRequest(request.query),
    destination,
  );
}
