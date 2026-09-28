import { join } from '#engine/membership.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/join — join by room id (the
// alias form lives at /join/#roomIdOrAlias). Body keys merge into the
// member content. M5b: a room we never held joins over federation with
// the room id's domain as the candidate (tuwunel
// api/client/membership/join.rs:69).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const body = (await parseJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  // membership.join dispatches: live → local; archived → reopen or
  // remote; never held → the remote dance (the room id's domain and the
  // inviter's server among the candidates)
  const res = await join(roomId, userId, body, {
    via: [domainOf(roomId)].filter((d) => d !== serverName()),
  });
  return { room_id: res.roomId };
}
