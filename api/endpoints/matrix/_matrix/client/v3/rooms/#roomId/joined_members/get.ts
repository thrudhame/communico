import { MatrixError } from '#engine/matrix-error.ts';
import { lookupRoom, membershipOf, stateAtSeq } from '#engine/room.ts';

// GET /_matrix/client/v3/rooms/#roomId/joined_members —
// {joined: {uid: {display_name, avatar_url}}} from the current member
// state; the keys are emitted even when null (from the member content).
// 403 M_FORBIDDEN when not joined.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const m = await membershipOf(roomId, context.state.user as string);
  if (m?.membership !== 'join') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
  const rows = (await stateAtSeq(roomId, null)) ?? [];
  const joined: Record<string, { display_name: unknown; avatar_url: unknown }> =
    {};
  for (const r of rows) {
    if (r.type !== 'm.room.member') continue;
    const content = r.content as {
      membership?: string;
      displayname?: unknown;
      avatar_url?: unknown;
    };
    if (content.membership !== 'join') continue;
    joined[r.stateKey] = {
      display_name: content.displayname ?? null,
      avatar_url: content.avatar_url ?? null,
    };
  }
  return { joined };
}
