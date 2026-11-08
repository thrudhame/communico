import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom, readPositionFor } from '#engine/client/room.ts';
import { messages } from '#engine/client/timeline.ts';
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
  const dir = request.query.get('dir');
  if (dir === null) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'dir is required');
  }
  if (dir !== 'b' && dir !== 'f') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad dir: ' + dir);
  }
  const limitRaw = request.query.get('limit');
  const limit = limitRaw !== null ? Math.max(0, Number(limitRaw) || 0) : 10;
  let lazyLoadMembers = false;
  let containsUrl: boolean | undefined;
  const filterRaw = request.query.get('filter');
  if (filterRaw !== null) {
    try {
      const f = JSON.parse(filterRaw);
      lazyLoadMembers = f?.lazy_load_members === true;
      if (typeof f?.contains_url === 'boolean') containsUrl = f.contains_url;
    } catch {
      throw new MatrixError(400, 'M_BAD_JSON', 'filter is not valid JSON');
    }
  }
  return await messages({
    roomId,
    userId: context.state.user as string,
    deviceId: (context.state.device as string | undefined) ?? null,
    leaveAt,
    dir,
    limit,
    fromToken: request.query.get('from'),
    toToken: request.query.get('to'),
    lazyLoadMembers,
    containsUrl,
  });
}
