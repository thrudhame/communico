import { config } from '#engine/config.ts';
import { aliasIsLocal, resolveAlias } from '#engine/aliases.ts';
import { MatrixError } from '#engine/matrix-error.ts';

// GET /_matrix/client/v3/directory/room/{roomAlias} — resolve an alias.
// PUBLIC (spec v1.16 directory.yaml:88-159, GET no security block).
// For a non-local alias the federation.lookups branch:
//   'known' answers from alias state of anything we hold (any creator);
//   'none' 404s without looking. The branch is added in front of the
// existing local 404, per "not a proxy" (design.md).
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
