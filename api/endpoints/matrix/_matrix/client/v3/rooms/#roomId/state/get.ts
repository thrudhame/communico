import {
  readPositionFor,
  requireRoom,
  stateAtSeq,
} from '#engine/client/room.ts';
import { clientEventsForRows } from '#engine/client/state.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  await requireRoom(roomId);
  const at = await readPositionFor(context.state.user as string, roomId);
  const rows = await stateAtSeq(roomId, at);
  return await clientEventsForRows(roomId, rows);
}
