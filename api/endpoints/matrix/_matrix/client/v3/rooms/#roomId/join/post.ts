import { join } from '#engine/client/membership.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const body = await parseJson(request).catch(() => ({})) as Record<
    string,
    unknown
  >;
  const res = await join(roomId, context.state.user as string, body, {
    via: roomId.includes(':')
      ? [domainOf(roomId)].filter((s) => s !== serverName())
      : [],
  });
  return { room_id: res.roomId };
}
