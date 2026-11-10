import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { roomSummary } from '#engine/client/discovery.ts';

export default async function (request: PathfinderRequest, context: Context) {
  return await roomSummary(
    request.params.roomIdOrAlias as string,
    context.state.user as string,
    request.query.getAll('via'),
  );
}
