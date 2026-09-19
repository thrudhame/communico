import { resolveAlias } from '#engine/aliases.ts';

// GET /_matrix/client/v3/directory/room/#roomAlias — resolve an alias.
// PUBLIC: no authorize() call and no 20-auth.ts in this folder — spec
// v1.16 directory.yaml:88-159 gives GET no security block (PUT :23-25,
// DELETE :175-177 carry it; http-contract pins the mix).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  return await resolveAlias(request.params.roomAlias as string);
}
