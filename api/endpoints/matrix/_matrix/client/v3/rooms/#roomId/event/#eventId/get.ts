import { MatrixError } from '#engine/matrix-error.ts';
import { eventIndexRow, lookupRoom } from '#engine/room.ts';
import { clientEventForRow, pduById } from '#engine/timeline.ts';
import { canSeeEvent } from '#engine/visibility.ts';

// GET /_matrix/client/v3/rooms/#roomId/event/#eventId — one event as a
// full client event. Visibility per visibility.ts (history_visibility at
// the event + the viewer's membership at it); not visible -> 404
// M_NOT_FOUND (spec + tests: 404, not 403). Rejected/soft-failed events
// are not in the client-visible timeline -> 404.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const eventId = request.params.eventId as string;
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const idx = await eventIndexRow(roomId, eventId);
  const pdu = idx ? await pduById(room.dbName, idx.commit_hash, eventId) : null;
  if (!idx || !pdu || idx.rejected || idx.soft_failed) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  if (
    !(await canSeeEvent(userId, roomId, {
      seq: idx.seq,
      type: pdu.type,
      stateKey: pdu.state_key,
    }))
  ) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  return await clientEventForRow(room.dbName, room.roomVersion, idx, {
    userId,
    deviceId: (context.state.device as string | undefined) ?? null,
  });
}
