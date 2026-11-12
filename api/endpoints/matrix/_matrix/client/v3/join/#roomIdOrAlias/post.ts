import { joinByIdOrAlias } from '#engine/client/membership.ts';
import { joinContent } from '#engine/client/membership-request.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const via = request.query.getAll('via');
  const legacy = request.query.getAll('server_name');
  const body = joinContent(await parseJson(request));
  const res = await joinByIdOrAlias(
    request.params.roomIdOrAlias as string,
    context.state.user as string,
    body,
    via.length > 0 ? via : legacy,
  );
  return { room_id: res.roomId };
}
