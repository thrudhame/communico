import { MatrixError } from '#engine/matrix-error.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { extremities, lookupRoom } from '#engine/room.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/rooms/#roomId/send/#type/#txnId — author + ingest
// a client event (F1). prev_events = current extremities' event IDs;
// author() fills depth, auth_events, hashes, id, and the server signature,
// then the same ingest path as remote events.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const type = request.params.type as string;
  const content = await parseJson(request);

  try {
    const room = await lookupRoom(roomId);
    if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);

    const prevEvents = (await extremities(room.dbName, roomId)).map((
      e: { eventId: string },
    ) => e.eventId);

    const pdu = await author(roomId, {
      type,
      sender: userId,
      content,
      prev_events: prevEvents,
      origin_server_ts: Date.now(),
    });
    const res = await ingestEvent(roomId, pdu);
    return { event_id: res.event_id };
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    const msg = String(e);
    if (msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')) {
      throw new MatrixError(403, 'M_STATE_REJECT', msg);
    }
    throw new MatrixError(500, 'M_UNKNOWN', msg);
  }
}
