import { requireRoom } from '#engine/client/room.ts';
import { memberOperation } from '#engine/client/membership.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  await requireRoom(roomId);
  const body = await parseJson(request).catch(() => ({})) as {
    user_id?: unknown;
    reason?: unknown;
  };
  if (typeof body.user_id !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'user_id required');
  }
  await memberOperation(
    'ban',
    roomId,
    context.state.user as string,
    body.user_id,
    typeof body.reason === 'string' ? body.reason : undefined,
  );
  return {};
}
