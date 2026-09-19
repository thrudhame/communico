import { authorize } from '#engine/auth.ts';
import { deleteAlias } from '#engine/aliases.ts';

// DELETE /_matrix/client/v3/directory/room/#roomAlias — remove the
// mapping. AUTH: protected by file-level authorize() as the first
// statement (spec v1.16 directory.yaml:175-177 carries security while
// GET in this folder does not — see put.ts for the mixed-folder note).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const userId = await authorize(request);
  await deleteAlias(request.params.roomAlias as string, userId);
  return {};
}
