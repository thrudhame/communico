import { MatrixError } from '#engine/matrix-error.ts';
import { roomAliases } from '#engine/aliases.ts';
import { lookupRoom, membershipOf, stateAtSeq } from '#engine/room.ts';

// GET /_matrix/client/v3/rooms/#roomId/aliases — the server's local
// aliases on the room. Members only; world_readable rooms are listable by
// anyone (spec v1.16 directory.yaml:219-222). 403 M_FORBIDDEN otherwise.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const userId = context.state.user as string;
  if ((await lookupRoom(roomId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const member = await membershipOf(roomId, userId);
  let allowed = member?.membership === 'join';
  if (!allowed) {
    const state = (await stateAtSeq(roomId, null)) ?? [];
    const hv = state.find(
      (r) => r.type === 'm.room.history_visibility' && r.stateKey === '',
    );
    allowed = hv !== undefined &&
      (hv.content as Record<string, unknown>).history_visibility ===
        'world_readable';
  }
  if (!allowed) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not a member of the room.',
    );
  }
  return { aliases: await roomAliases(roomId) };
}
