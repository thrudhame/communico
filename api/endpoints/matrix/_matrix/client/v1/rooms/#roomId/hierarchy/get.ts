import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { clientHierarchy, hierarchyQuery } from '#engine/client/hierarchy.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await clientHierarchy(
    request.params.roomId as string,
    context.state.user as string,
    hierarchyQuery(request.query),
  );
}
