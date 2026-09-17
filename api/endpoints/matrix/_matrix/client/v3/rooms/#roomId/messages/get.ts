import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom, parseStreamToken } from '#engine/room.ts';
import { messages } from '#engine/timeline.ts';
import { readPositionFor } from '#engine/visibility.ts';

// GET /_matrix/client/v3/rooms/#roomId/messages — plan §3f: dir is
// required (400 M_MISSING_PARAM), from/to are sync tokens (the s…_p…
// grammar), limit defaults to 10, filter is inline JSON
// (lazy_load_members). 403 M_FORBIDDEN for an unknown room or a
// non-member (TestFetchMessagesFromNonExistentRoom).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const dirRaw = request.query.get('dir');
  if (dirRaw === null) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'dir is required');
  }
  if (dirRaw !== 'b' && dirRaw !== 'f') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad dir: ' + dirRaw);
  }
  if ((await lookupRoom(roomId)) === null) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not a member of the room',
    );
  }
  const leaveAt = await readPositionFor(context.state.user as string, roomId);
  const from = parseStreamToken(request.query.get('from'));
  const to = parseStreamToken(request.query.get('to'));
  const limitRaw = request.query.get('limit');
  const limit = limitRaw !== null ? Math.max(0, Number(limitRaw) || 0) : 10;
  let lazyLoadMembers = false;
  const filterRaw = request.query.get('filter');
  if (filterRaw !== null) {
    try {
      const f = JSON.parse(filterRaw) as { lazy_load_members?: unknown };
      lazyLoadMembers = f?.lazy_load_members === true;
    } catch {
      throw new MatrixError(400, 'M_BAD_JSON', 'filter is not valid JSON');
    }
  }
  return await messages({
    roomId,
    userId: context.state.user as string,
    deviceId: (context.state.device as string | undefined) ?? null,
    leaveAt,
    dir: dirRaw,
    fromSeq: from?.eSeq ?? null,
    toSeq: to?.eSeq ?? null,
    limit,
    lazyLoadMembers,
  });
}
