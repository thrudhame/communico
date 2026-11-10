import { resolveAlias } from '#engine/client/directory.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const alias = request.params.roomAlias as string;
  return await resolveAlias(alias);
}
