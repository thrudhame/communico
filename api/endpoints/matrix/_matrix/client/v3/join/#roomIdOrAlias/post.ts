import { MatrixError } from '#engine/matrix-error.ts';
import { join } from '#engine/membership.ts';
import { lookupAlias, lookupRoom } from '#engine/room.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/join/#roomIdOrAlias — join by room id or alias
// (alias → room_aliases). Body keys merge into the member content (the
// foo:bar test); the server_name query is ignored (federation is M5).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const idOrAlias = request.params.roomIdOrAlias as string;
  let roomId = idOrAlias;
  if (idOrAlias.startsWith('#')) {
    const resolved = await lookupAlias(idOrAlias);
    if (resolved === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'unknown alias: ' + idOrAlias);
    }
    roomId = resolved;
  }
  if ((await lookupRoom(roomId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const body = (await parseJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const res = await join(roomId, userId, body);
  return { room_id: res.roomId };
}
