import { theApp } from '#engine/app.ts';
import { requireRoom, stateAtSeq } from '#engine/client/room.ts';
import { membershipOf } from '#engine/server/read.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  await requireRoom(roomId);
  if (
    (await membershipOf(theApp().server, roomId, context.state.user as string))
      ?.membership !== 'join'
  ) throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  const joined: Record<string, { display_name: unknown; avatar_url: unknown }> =
    {};
  for (const row of await stateAtSeq(roomId, null)) {
    if (row.type === 'm.room.member' && row.content.membership === 'join') {
      joined[row.stateKey] = {
        display_name: row.content.displayname ?? null,
        avatar_url: row.content.avatar_url ?? null,
      };
    }
  }
  return { joined };
}
