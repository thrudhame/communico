import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom, parseStreamToken, stateAtSeq } from '#engine/room.ts';
import { clientEventsForRows } from '#engine/stateops.ts';
import { readPositionFor } from '#engine/visibility.ts';

// GET /_matrix/client/v3/rooms/#roomId/members — {chunk: [member events]}.
// ?at= (a sync token → the state at that seq), ?membership= /
// ?not_membership= filters; left users read as of their leave (an ?at=
// past it clamps).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const leaveAt = await readPositionFor(context.state.user as string, roomId);
  const atParam = parseStreamToken(request.query.get('at'));
  const at = atParam === null
    ? leaveAt
    : (leaveAt === null ? atParam.eSeq : Math.min(atParam.eSeq, leaveAt));
  const membership = request.query.get('membership');
  const notMembership = request.query.get('not_membership');
  const rows = ((await stateAtSeq(roomId, at)) ?? []).filter((r) => {
    if (r.type !== 'm.room.member') return false;
    const ms = (r.content as { membership?: string }).membership;
    if (membership !== null && ms !== membership) return false;
    if (notMembership !== null && ms === notMembership) return false;
    return true;
  });
  return { chunk: await clientEventsForRows(room.dbName, roomId, rows) };
}
