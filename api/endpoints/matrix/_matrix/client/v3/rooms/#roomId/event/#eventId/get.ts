import { eventFor } from '#engine/client/timeline.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await eventFor(
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    request.params.roomId as string,
    request.params.eventId as string,
  );
}
