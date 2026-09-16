import { readStateKey } from '#engine/stateops.ts';

// GET /_matrix/client/v3/rooms/#roomId/state/#type — the empty state key
// (bare or trailing-slash form; pathfinder tolerates exactly one trailing
// slash at leaf acceptance).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await readStateKey(
    request.params.roomId as string,
    context.state.user as string,
    request.params.type as string,
    '',
    request.query.get('format'),
  );
}
