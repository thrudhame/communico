import {
  readPositionFor,
  requireRoom,
  stateSeqAtToken,
} from '#engine/client/room.ts';
import { clientEventsForRows } from '#engine/client/state.ts';
import { admitState } from '#engine/client/state-admission.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const roomId = request.params.roomId as string;
  const room = await requireRoom(roomId);
  const leaveAt = await readPositionFor(context.state.user as string, roomId);
  const membership = request.query.get('membership'),
    notMembership = request.query.get('not_membership');
  const at = await stateSeqAtToken(roomId, request.query.get('at'), leaveAt);
  const admission = await admitState(room, {
    userId: context.state.user as string,
    ...(at === null ? {} : { point: { seq: at } }),
    allowInvited: request.query.has('at'),
  });
  const rows = admission.rows
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
      { admission },
    ),
  };
}
