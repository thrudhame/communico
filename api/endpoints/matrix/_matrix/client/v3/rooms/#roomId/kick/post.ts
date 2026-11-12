import { requireRoom } from '#engine/client/room.ts';
import { memberOperation } from '#engine/client/membership.ts';
import { membershipContent } from '#engine/client/membership-request.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  await requireRoom(roomId);
  const body = membershipContent(await parseJson(request));
  if (typeof body.user_id !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'user_id required');
  }
  await memberOperation(
    'kick',
    roomId,
    context.state.user as string,
    body.user_id,
    body.reason,
  );
  return {};
}
