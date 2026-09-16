import { MatrixError } from '#engine/matrix-error.ts';
import { serverName } from '#engine/config.ts';
import { authorAndIngest } from '#engine/ingest.ts';
import { lookupRoom } from '#engine/room.ts';
import { lookupTransaction, recordTransaction } from '#engine/tenant.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/rooms/#roomId/send/#type/#txnId — author + ingest
// a client event (F1), with M4 transaction idempotency scoped to
// (device, room, txn): a repeat send returns the recorded event_id
// regardless of content (Complement txnid_test.go).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const deviceId = (context.state.device as string | undefined) ?? null;
  const roomId = request.params.roomId as string;
  const type = request.params.type as string;
  const txnId = request.params.txnId as string;
  const content = await parseJson(request);

  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }

  if (deviceId !== null) {
    const seen = await lookupTransaction(serverName(), deviceId, roomId, txnId);
    if (seen !== null) return { event_id: seen };
  }

  try {
    const res = await authorAndIngest(
      roomId,
      {
        type,
        sender: userId,
        content,
        origin_server_ts: Date.now(),
      },
      deviceId !== null ? { txn: { deviceId, txnId } } : undefined,
    );
    if (deviceId !== null) {
      await recordTransaction(
        serverName(),
        deviceId,
        roomId,
        txnId,
        res.event_id,
      );
    }
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
