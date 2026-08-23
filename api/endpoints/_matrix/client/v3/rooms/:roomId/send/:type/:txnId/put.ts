import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../../../../../engine/auth.ts';
import { ingestEvent } from '../../../../../../../../../engine/ingest.ts';
import { extremities, lookupRoom } from '../../../../../../../../../engine/room.ts';
import { SERVER_DB, withDb } from '../../../../../../../../../engine/db.ts';

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

    // prev_events = current extremities' event IDs (x* branches ->
    // event_index.branch_name map; stale rows filtered by live branches)
    const xbranches = await extremities(room.dbName);
    const prevEvents = await withDb(SERVER_DB, async (c) => {
      if (xbranches.length === 0) return [] as string[];
      const r = await c.query(
        'SELECT event_id FROM event_index WHERE room_id = $1 AND branch_name = ANY($2);',
        [roomId, xbranches],
      );
      // deno-lint-ignore no-explicit-any
      return r.rows.map((row: any) => String(row.event_id));
    });

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
