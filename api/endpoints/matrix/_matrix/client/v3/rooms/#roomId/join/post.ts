import { join } from '#engine/client/membership.ts';
import { joinContent } from '#engine/client/membership-request.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '#engine/operation-body.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const body = joinContent(await parseJson(request));
  const res = await join(roomId, context.state.user as string, body, {
    via: roomId.includes(':')
      ? [domainOf(roomId)].filter((s) => s !== serverName())
      : [],
  });
  return { room_id: res.roomId };
}
