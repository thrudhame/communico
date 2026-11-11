// G6/F14: one client visibility policy on the event's own stored state.
// Own membership events are visible even without a qualifying join. Other
// state transitions use either side's policy. Published state can prove a later join;
// it never substitutes for the event's own visibility or membership.
import type { Room, RoomTx } from '#engine/room/index.ts';
export async function canSeeEvent(
  userId: string,
  room: Room,
  eventId: string,
): Promise<boolean> {
  return await room.tx((tx) => canSeeEventAt(userId, tx, eventId));
}

/** Shared event-state policy. Publication consumers supply their exact live
 * cut's group, so a later room publication cannot grant earlier eligibility. */
export async function canSeeEventAt(
  userId: string,
  tx: RoomTx,
  eventId: string,
  liveGroup?: number,
): Promise<boolean> {
  const event = await tx.events.get(eventId);
  const status = await tx.events.getStatus(eventId);
  if (
    event === null || status?.standing !== 'accepted' ||
    status.grounding !== 'grounded'
  ) return false;
  if (event.type === 'm.room.member' && event.state_key === userId) {
    return true;
  }
  const refs = await tx.state.eventReadState(eventId);
  if (refs === null) return false;
  const contents = new Map<string, Record<string, unknown>>();
  const content = async (group: number, type: string, key: string) => {
    const id = await tx.state.groupKey(group, type, key);
    if (id === null) return {};
    if (!contents.has(id)) {
      const row = await tx.events.get(id);
      contents.set(
        id,
        row === null
          ? {}
          : JSON.parse(row.pdu).content as Record<string, unknown>,
      );
    }
    return contents.get(id)!;
  };
  const atGroup = async (group: number) => ({
    hv: (await content(group, 'm.room.history_visibility', ''))
      .history_visibility,
    membership: (await content(group, 'm.room.member', userId)).membership,
  });
  const states = [await atGroup(refs.after.group)];
  if (event.type === 'm.room.history_visibility') {
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
    const groups = liveGroup === undefined
      ? await tx.state.publishedGroupsAfter(eventId)
      : [liveGroup];
    for (const group of groups) {
      if (
        (await content(group, 'm.room.member', userId)).membership === 'join'
      ) {
        return true;
      }
    }
  }
  return false;
}
