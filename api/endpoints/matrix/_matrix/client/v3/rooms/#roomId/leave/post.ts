import { leave } from '#engine/client/membership.ts';
import { membershipContent } from '#engine/client/membership-request.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = membershipContent(await parseJson(request));
  await leave(
    request.params.roomId as string,
    context.state.user as string,
    body.reason,
  );
  return {};
}
