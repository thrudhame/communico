import { MatrixError } from '#engine/matrix-error.ts';
import { join } from '#engine/membership.ts';
import { lookupRoom } from '#engine/room.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/join — join by room id (the
// alias form lives at /join/#roomIdOrAlias). Body keys merge into the
// member content.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  if ((await lookupRoom(roomId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const body = (await parseJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const res = await join(roomId, userId, body);
  return { room_id: res.roomId };
}
