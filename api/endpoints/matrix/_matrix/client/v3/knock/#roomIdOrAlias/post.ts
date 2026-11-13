import { joinByIdOrAlias, knock } from '#engine/client/membership.ts';
import { parseJson } from '#engine/operation-body.ts';
import { membershipContent } from '#engine/client/membership-request.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest, context: Context) {
  const body = membershipContent(await parseJson(request));
  const via = request.query.getAll('via');
  const result = await joinByIdOrAlias(
    request.params.roomIdOrAlias as string,
    context.state.user as string,
    body,
    via.length ? via : request.query.getAll('server_name'),
    knock,
  );
  return { room_id: result.roomId };
}
