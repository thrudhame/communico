import { config } from '#engine/config.ts';
import { aliasIsLocal, resolveAlias } from '#engine/client/directory.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const alias = request.params.roomAlias as string;
  if (!aliasIsLocal(alias)) {
    const fed = config().federation;
    if (!(fed.enabled && fed.lookups === 'known')) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'unknown alias');
    }
  }
  return await resolveAlias(alias);
}
