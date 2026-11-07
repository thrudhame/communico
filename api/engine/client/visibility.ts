// G6/F14: one client visibility policy on the event's own stored state.
// A state transition is visible when either side permits it (CS history
// visibility). Published state can prove a later join for shared history;
// it never substitutes for the event's own visibility or membership.
import type { Room } from '#engine/room/index.ts';
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
    const refs = await tx.state.eventReadState(eventId);
    if (refs === null) return null;
    const content = async (group: number, type: string, key: string) => {
      const id = await tx.state.groupKey(group, type, key);
      const row = id === null ? null : await tx.events.get(id);
      return row === null
        ? {}
        : JSON.parse(row.pdu).content as Record<string, unknown>;
    };
    const atGroup = async (group: number) => ({
      hv: (await content(group, 'm.room.history_visibility', ''))
        .history_visibility,
      membership: (await content(group, 'm.room.member', userId)).membership,
    });
    const states = [await atGroup(refs.after.group)];
    if (
      event.type === 'm.room.history_visibility' ||
      (event.type === 'm.room.member' && event.state_key === userId)
    ) {
      states.push(await atGroup(refs.before.group));
    }
    let shared = false;
    for (const state of states) {
      if (state.hv === 'world_readable' || state.membership === 'join') {
        return true;
      }
      if (state.hv === 'invited' && state.membership === 'invite') return true;
      // Shared (including unknown values) needs a qualifying join at the
      // event or later. A current invite/leave/ban row proves neither.
      if (!['joined', 'invited', 'world_readable'].includes(String(state.hv))) {
        shared = true;
      }
    }
    if (shared) {
      for (const group of await tx.state.publishedGroupsAfter(eventId)) {
        if (
          (await content(group, 'm.room.member', userId)).membership === 'join'
        ) {
          return true;
        }
      }
    }
    return false;
  });
  return at === true;
}
