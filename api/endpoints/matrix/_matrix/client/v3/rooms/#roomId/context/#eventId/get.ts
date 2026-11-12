import { eventContext } from '#engine/client/timeline.ts';
import { decodeTimelineWindow } from '#engine/client/timeline-request.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const decoded = decodeTimelineWindow(request.query);
  return await eventContext(
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    request.params.roomId as string,
    request.params.eventId as string,
    decoded,
  );
}
