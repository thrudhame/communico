import { reportContent } from '#engine/client/reports.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await reportContent(
    'user',
    context.state.user as string,
    request.params.userId as string,
    await parseJson(request),
  );
}
