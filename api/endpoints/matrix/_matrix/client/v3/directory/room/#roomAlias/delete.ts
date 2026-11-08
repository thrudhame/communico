import { authorize } from '#engine/auth-context.ts';
import { deleteAlias } from '#engine/client/directory.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const user = await authorize(request);
  await deleteAlias(request.params.roomAlias as string, user);
  return {};
}
