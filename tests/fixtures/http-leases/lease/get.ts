import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import type {} from '#root/api/types.d.ts';
import type { Room } from '#engine/room/index.ts';
const held = new Map<string, Room>();
export function remember(room: Room) {
  held.set(room.id, room);
}
export function clear() {
  held.clear();
}
export default async function (request: PathfinderRequest, context: Context) {
  const room = held.get(request.query.get('room')!);
  if (room === undefined) throw new Error('missing test room');
  const member = await room.tx(async (tx) => {
    const stay = await tx.segments.latestStay();
    const group = stay === null ? null : await tx.state.current(stay.id);
    const event = group === null ? null : await tx.state.groupKey(
      group,
      'm.room.member',
      context.state.user as string,
    );
    const row = event === null ? null : await tx.events.get(event);
    return row === null ? null : JSON.parse(row.pdu).content.membership;
  });
  return { room: room.id, membership: member, user: context.state.user };
}
