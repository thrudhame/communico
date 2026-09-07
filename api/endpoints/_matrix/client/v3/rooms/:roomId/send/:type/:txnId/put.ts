import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import type { HttpError } from '@oak/oak';
import { authorize } from '../../../../../../../../../engine/auth.ts';
import { author, ingestEvent } from '../../../../../../../../../engine/ingest.ts';
import { extremities, lookupRoom } from '../../../../../../../../../engine/room.ts';
import { SERVER_NAME } from '../../../../../../../../../engine/config.ts';

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
    void SERVER_NAME;

    // prev_events = current extremities' event IDs; author() fills depth,
    // auth_events, hashes, id, and the server signature, then the same
    // ingest path as remote events.
    const prevEvents = (await extremities(room.dbName, roomId))
      .map((e) => e.eventId);

    const pdu = await author(roomId, {
      type,
      sender: userId,
      content,
      prev_events: prevEvents,
      origin_server_ts: Date.now(),
    });
    const res = await ingestEvent(roomId, pdu);
    return [null, { event_id: res.event_id }];
  } catch (e) {
    const msg = String(e);
    // The outcome type pins HttpError<500>; semantic statuses ride the
    // message (house pattern — the framework maps the message prefix).
    type As500 = HttpError<Status.InternalServerError>;
    if (msg.includes('M_UNRESOLVED_CONFLICT')) {
      return [
        createHttpError(Status.Conflict, msg) as unknown as As500,
        null,
      ];
    }
    if (
      msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')
    ) {
      return [
        createHttpError(Status.Forbidden, msg) as unknown as As500,
        null,
      ];
    }
    return [createHttpError(Status.InternalServerError, msg), null];
  }
}
