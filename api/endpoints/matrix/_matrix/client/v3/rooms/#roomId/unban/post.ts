import { MatrixError } from '#engine/matrix-error.ts';
import { unban } from '#engine/membership.ts';
import { lookupRoom } from '#engine/room.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/unban — body {user_id, reason?}.
// The spec's leave-from-ban (banning.yaml:90-135). {} response.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  if ((await lookupRoom(roomId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const body = (await parseJson(request).catch(() => ({}))) as {
    user_id?: unknown;
    reason?: unknown;
  };
  if (typeof body.user_id !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'user_id required');
  }
  await unban(
    roomId,
    userId,
    body.user_id,
    typeof body.reason === 'string' ? body.reason : undefined,
  );
  return {};
}
