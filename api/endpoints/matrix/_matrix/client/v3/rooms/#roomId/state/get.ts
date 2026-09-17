import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom, stateAtSeq } from '#engine/room.ts';
import { clientEventsForRows } from '#engine/stateops.ts';
import { readPositionFor } from '#engine/visibility.ts';

// GET /_matrix/client/v3/rooms/#roomId/state — the room's state as an
// array of full client events, from `main` (or as-of-leave for left
// users). 403 for non-members.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const at = await readPositionFor(context.state.user as string, roomId);
  const rows = (await stateAtSeq(roomId, at)) ?? [];
  return await clientEventsForRows(room.dbName, roomId, rows, room.roomVersion);
}
