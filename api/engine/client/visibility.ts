// G6: every event read uses its own stored state, never current state.
import { theApp } from '#engine/app.ts';
import type { Room } from '#engine/room/index.ts';
import { membershipOf } from '#engine/server/read.ts';
export async function canSeeEvent(
  userId: string,
  room: Room,
  eventId: string,
): Promise<boolean> {
  const at = await room.tx(async (tx) => {
    const event = await tx.events.get(eventId);
    const status = await tx.events.getStatus(eventId);
    if (
      event === null || status?.standing !== 'accepted' ||
      status.grounding !== 'grounded'
    ) return null;
    if (event.type === 'm.room.member' && event.state_key === userId) {
      return { own: true, hv: '', membership: '' };
    }
    const refs = await tx.state.eventReadState(eventId);
    if (refs === null) return null;
    const content = async (type: string, key: string) => {
      const id = await tx.state.groupKey(refs.after.group, type, key);
      const row = id === null ? null : await tx.events.get(id);
      return row === null
        ? {}
        : JSON.parse(row.pdu).content as Record<string, unknown>;
    };
    return {
      own: false,
      hv: (await content('m.room.history_visibility', '')).history_visibility ??
        'shared',
      membership: (await content('m.room.member', userId)).membership,
    };
  });
  if (at === null) return false;
  if (at.own || at.hv === 'world_readable' || at.membership === 'join') {
    return true;
  }
  if (at.hv === 'shared') {
    return await membershipOf(theApp().server, room.id, userId) !== null;
  }
  return at.hv === 'invited' && at.membership === 'invite';
}
