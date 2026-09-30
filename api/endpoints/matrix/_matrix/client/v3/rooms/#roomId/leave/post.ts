import { MatrixError } from '#engine/matrix-error.ts';
import { leave } from '#engine/membership.ts';
import { inviteFor } from '#engine/federation/invites.ts';
import { lookupRoom } from '#engine/room.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/leave — self-leave (also the
// invite-rejection path). Body: {reason?}. {} response.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  if ((await lookupRoom(roomId)) === null) {
    // an out-of-band invite (a room we do not hold) is still a leave —
    // the reject path lives in membership.leave (fix pass §3.6c,
    // TestFederationRejectInvite)
    if ((await inviteFor(roomId, userId)) === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
    }
  }
  const body = (await parseJson(request).catch(() => ({}))) as {
    reason?: unknown;
  };
  await leave(
    roomId,
    userId,
    typeof body.reason === 'string' ? body.reason : undefined,
  );
  return {};
}
