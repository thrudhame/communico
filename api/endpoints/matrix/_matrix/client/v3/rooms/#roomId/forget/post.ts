import { forget } from '#engine/client/membership.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  await forget(request.params.roomId as string, context.state.user as string);
  return {};
}
