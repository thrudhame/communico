import { leave } from '#engine/client/membership.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = await parseJson(request).catch(() => ({})) as {
    reason?: unknown;
  };
  await leave(
    request.params.roomId as string,
    context.state.user as string,
    typeof body.reason === 'string' ? body.reason : undefined,
  );
  return {};
}
