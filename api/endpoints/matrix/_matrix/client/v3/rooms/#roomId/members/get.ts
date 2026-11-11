import {
  readPositionFor,
  requireRoom,
  stateAtSeq,
  stateSeqAtToken,
} from '#engine/client/room.ts';
import { clientEventsForRows } from '#engine/client/state.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  await requireRoom(roomId);
  const leaveAt = await readPositionFor(context.state.user as string, roomId);
  const membership = request.query.get('membership'),
    notMembership = request.query.get('not_membership');
  const at = await stateSeqAtToken(roomId, request.query.get('at'), leaveAt);
  const rows = (await stateAtSeq(roomId, at))
    .filter((r) =>
      r.type === 'm.room.member' &&
      (membership === null || r.content.membership === membership) &&
      (notMembership === null || r.content.membership !== notMembership)
    );
  return {
    chunk: await clientEventsForRows(
      roomId,
      rows,
      context.state.user as string,
      {
        ...(at === null ? {} : { point: { seq: at } }),
        allowInvited: request.query.has('at'),
      },
    ),
  };
}
