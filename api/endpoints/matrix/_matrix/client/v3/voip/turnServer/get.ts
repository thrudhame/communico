import { turnServer } from '#engine/turn.ts';

export default function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return turnServer(context.state.user as string);
}
