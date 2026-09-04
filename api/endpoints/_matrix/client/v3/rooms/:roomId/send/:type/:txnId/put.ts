import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../../../../../engine/auth.ts';
import { ingestEvent } from '../../../../../../../../../engine/ingest.ts';
import { extremities, lookupRoom } from '../../../../../../../../../engine/room.ts';

export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  let userId: string;
  try {
    userId = await authorize(request);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }

  const roomId = decodeURIComponent(request.params.roomId!);
  const type = request.params.type!;
  const content = await request.body.json();

  try {
    const room = await lookupRoom(roomId);
    if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);

    // prev_events = current extremities' event IDs
    const prevEvents = (await extremities(room.dbName, roomId))
      .map((e) => e.eventId);

    const res = await ingestEvent(roomId, {
      type,
      sender: userId,
      content,
      prev_events: prevEvents,
      origin_ts: Date.now(),
    });
    return [null, { event_id: res.event_id }];
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
