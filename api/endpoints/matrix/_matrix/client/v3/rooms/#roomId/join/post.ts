import { join } from '#engine/client/membership.ts';
import { membershipContent } from '#engine/client/membership-request.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const body = membershipContent(await parseJson(request));
  const res = await join(roomId, context.state.user as string, body, {
    via: roomId.includes(':')
      ? [domainOf(roomId)].filter((s) => s !== serverName())
      : [],
  });
  return { room_id: res.roomId };
}
