import { MatrixError } from '#engine/matrix-error.ts';
import { createRoom } from '#engine/room.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/createRoom — F0: default version '11'.
// Non-string/unknown versions are rejected (never a silent default —
// Complement 32room-versions); createRoom enforces via the policy registry.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  let body: { room_version?: unknown } = {};
  try {
    body = (await parseJson(request)) as { room_version?: unknown };
  } catch (e) {
    if (e instanceof Error && e.name === 'ParseError') body = {};
    else throw e;
  }
  const roomVersion = body.room_version ?? '11';
  const roomId = '!' + crypto.randomUUID() + ':' + serverName();
  try {
    await createRoom(
      roomId,
      roomVersion as string,
      context.state.user as string,
    );
  } catch (e) {
    const msg = String(e);
    if (msg.includes('M_UNSUPPORTED_ROOM_VERSION')) {
      throw new MatrixError(400, 'M_UNSUPPORTED_ROOM_VERSION', msg);
    }
    if (e instanceof MatrixError) throw e;
    throw new MatrixError(500, 'M_UNKNOWN', msg);
  }
  return { room_id: roomId };
}
