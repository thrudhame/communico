import { reportContent } from '#engine/client/reports.ts';
import { parseJson } from '#engine/operation-body.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await reportContent(
    'event',
    context.state.user as string,
    request.params.roomId as string,
    await parseJson(request),
    request.params.eventId as string,
  );
}
