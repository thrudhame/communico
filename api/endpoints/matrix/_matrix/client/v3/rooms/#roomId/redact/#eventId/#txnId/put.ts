import { MatrixError } from '#engine/matrix-error.ts';
import { serverName } from '#engine/config.ts';
import { lookupRoom } from '#engine/room.ts';
import { redactEvent } from '#engine/redaction.ts';
import { lookupTransaction, recordTransaction } from '#engine/tenant.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/rooms/#roomId/redact/#eventId/#txnId — author +
// ingest an m.room.redaction (spec redaction.yaml at v1.16), mark the
// target's event_index row. {event_id}; txn-idempotent like /send.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const deviceId = (context.state.device as string | undefined) ?? null;
  const roomId = request.params.roomId as string;
  const eventId = request.params.eventId as string;
  const txnId = request.params.txnId as string;
  const body = (await parseJson(request).catch(() => ({}))) as {
    reason?: unknown;
  };
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  if ((await lookupRoom(roomId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }

  if (deviceId !== null) {
    const seen = await lookupTransaction(serverName(), deviceId, roomId, txnId);
    if (seen !== null) return { event_id: seen };
  }

  const res = await redactEvent(
    roomId,
    userId,
    eventId,
    reason,
    deviceId !== null ? { deviceId, txnId } : undefined,
  );
  if (deviceId !== null) {
    await recordTransaction(serverName(), deviceId, roomId, txnId, res.eventId);
  }
  return { event_id: res.eventId };
}
