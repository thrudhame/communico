import { MatrixError } from '#engine/matrix-error.ts';
import { join } from '#engine/membership.ts';
import { lookupRoom } from '#engine/room.ts';
import { joinRemoteRoom } from '#engine/federation/joins.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/join — join by room id (the
// alias form lives at /join/#roomIdOrAlias). Body keys merge into the
// member content. M5b: a room we never held joins over federation with
// the room id's domain as the candidate (tuwunel
// api/client/membership/join.rs:69).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const body = (await parseJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const room = await lookupRoom(roomId);
  if (room !== null) {
    const res = await join(roomId, userId, body);
    return { room_id: res.roomId };
  }
  const candidates = [domainOf(roomId)].filter((d) => d !== serverName());
  if (candidates.length === 0) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const res = await joinRemoteRoom(roomId, userId, candidates, body);
  return { room_id: res.roomId };
}
