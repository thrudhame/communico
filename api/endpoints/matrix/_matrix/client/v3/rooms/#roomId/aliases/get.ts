import { roomAliases } from '#engine/client/directory.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return {
    aliases: await roomAliases(
      request.params.roomId as string,
      context.state.user as string,
    ),
  };
}
