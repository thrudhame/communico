import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom } from '#engine/room.ts';
import { stateNow } from '#engine/timeline.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
) {
  const roomId = request.params.roomId as string;
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_ROOM_NOT_FOUND', 'room not found: ' + roomId);
  }
  return await stateNow(room.dbName);
}
