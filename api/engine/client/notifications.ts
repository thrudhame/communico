import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom } from './room.ts';
import { renderEvent, renderInviteNotification } from './render.ts';
import { pruneNotificationHistory } from '#engine/server/notification-history.ts';
import type { Pdu } from '#engine/pdu.ts';

function invalid(message: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', message);
}

/** Exclusive stable cursors refer to saved notification sequence, never offsets.
 * Hidden rows advance the scan too, so an unavailable event cannot trap a page. */
export async function notificationsFor(
  userId: string,
  deviceId: string | null,
  query: URLSearchParams,
) {
  const from = query.get('from');
  let cursor = Number.MAX_SAFE_INTEGER;
  if (from !== null) {
    if (!/^n[1-9][0-9]*$/.test(from)) invalid('invalid notification cursor');
    cursor = Number(from.slice(1));
    if (!Number.isSafeInteger(cursor)) invalid('invalid notification cursor');
  }
  const rawLimit = query.get('limit');
  if (
    rawLimit !== null &&
    (!/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))
  ) invalid('limit must be a positive integer');
  const limit = Math.min(rawLimit === null ? 50 : Number(rawLimit), 100);
  const only = query.get('only');
  if (only !== null && only !== 'highlight') invalid('only must be highlight');
  const app = theApp();
  const now = Date.now();
  const rows = await app.server.tx(async (tx) => {
    await pruneNotificationHistory(tx, now);
    return await tx.query(
      `SELECT n.* FROM notification_history h JOIN notifications n ON n.seq=h.seq
      WHERE h.user=? AND h.seq<? AND (?=0 OR h.highlight=1) ORDER BY h.seq DESC LIMIT 501`,
      [userId, cursor, only === 'highlight' ? 1 : 0],
    );
  });
  const notifications: Record<string, unknown>[] = [];
  let scanned = 0;
  for (const row of rows.slice(0, 500)) {
    const roomId = String(row.room);
    const eventId = String(row.event);
    const room = await lookupRoom(roomId);
    const viewer = { userId, deviceId, tenant: app.tenant };
    let event = room === null
      ? null
      : await renderEvent(room, eventId, viewer, { omitRoomId: true });
    if (event === null) {
      const invite = (await app.server.query(
        "SELECT event_json FROM federation_invites WHERE room_id=? AND user_id=? AND event_id=? AND status='pending'",
        [roomId, userId, eventId],
      ))[0];
      if (invite) {
        event = renderInviteNotification(
          JSON.parse(String(invite.event_json)) as Pdu,
          eventId,
          viewer,
        );
      }
    }
    if (event !== null && notifications.length === limit) {
      return { notifications, next_token: 'n' + cursor };
    }
    cursor = Number(row.seq);
    scanned++;
    if (event === null) continue;
    notifications.push({
      actions: JSON.parse(String(row.actions)),
      event,
      read: row.read_ms !== null,
      room_id: roomId,
      ts: Number(row.created_ms),
    });
  }
  return {
    notifications,
    ...(rows.length > scanned ? { next_token: 'n' + cursor } : {}),
  };
}
