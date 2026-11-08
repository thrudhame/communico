import { readStateKey } from '#engine/client/state.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await readStateKey(
    request.params.roomId as string,
    context.state.user as string,
    request.params.type as string,
    request.params.stateKey as string,
    request.query.get('format'),
  );
}
