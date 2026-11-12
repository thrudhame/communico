import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom, readPositionFor } from '#engine/client/room.ts';
import { messages } from '#engine/client/timeline.ts';
import { decodeMessagesRequest } from '#engine/client/timeline-request.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  if (await lookupRoom(roomId) === null) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not a member of the room',
    );
  }
  const leaveAt = await readPositionFor(context.state.user as string, roomId);
  const decoded = decodeMessagesRequest(request.query);
  return await messages({
    roomId,
    userId: context.state.user as string,
    deviceId: (context.state.device as string | undefined) ?? null,
    leaveAt,
    ...decoded,
  });
}
