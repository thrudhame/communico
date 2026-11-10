import { theApp } from '#engine/app.ts';
import { requireRoom, stateAtSeq } from '#engine/client/room.ts';
import { membershipOf } from '#engine/server/read.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { clientEventsForRows } from '#engine/client/state.ts';
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
  for (
    const row of await clientEventsForRows(
      roomId,
      await stateAtSeq(roomId, null),
      context.state.user as string,
    )
  ) {
    const content = row.content as Record<string, unknown>;
    if (row.type === 'm.room.member' && content.membership === 'join') {
      joined[String(row.state_key)] = {
        display_name: content.displayname ?? null,
        avatar_url: content.avatar_url ?? null,
      };
    }
  }
  return { joined };
}
