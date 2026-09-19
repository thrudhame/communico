import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/auth.ts';
import { serverName } from '#engine/config.ts';
import { setReceipt } from '#engine/receipts.ts';
import { putAccountData } from '#engine/tenant.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/read_markers — set the fully-read
// marker (room account_data) and optionally the read receipt(s) (spec
// v1.16 read_markers.yaml:38-67; band C §2). m.fully_read is stored as
// room account_data {event_id}; m.read / m.read.private become receipts.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const body = (await parseJson(request)) as Record<string, unknown>;
  for (const key of ['m.fully_read', 'm.read', 'm.read.private']) {
    const v = body[key];
    if (v !== undefined && typeof v !== 'string') {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        key + ' must be an event id',
      );
    }
  }
  if (typeof body['m.fully_read'] === 'string') {
    await putAccountData(
      serverName(),
      localpartOf(userId),
      roomId,
      'm.fully_read',
      {
        event_id: body['m.fully_read'],
      },
    );
  }
  if (typeof body['m.read'] === 'string') {
    await setReceipt(roomId, userId, 'm.read', body['m.read']);
  }
  if (typeof body['m.read.private'] === 'string') {
    await setReceipt(roomId, userId, 'm.read.private', body['m.read.private']);
  }
  return {};
}
