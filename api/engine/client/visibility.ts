// G6/F14: one client visibility policy on the event's own stored state.
// Own membership events are visible even without a qualifying join. Other
// state transitions use either side's policy. Published state can prove a later join;
// it never substitutes for the event's own visibility or membership.
import type { Room, RoomTx } from '#engine/room/index.ts';
import type { EventRow, Status } from '#engine/room/events.ts';
import type { GroupKey } from '#engine/room/state.ts';

function contentOf(row: EventRow | undefined | null): Record<string, unknown> {
  const value: unknown = row == null ? null : JSON.parse(row.pdu).content;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function visibility(hv: unknown, membership: unknown) {
  return hv === 'world_readable' || membership === 'join' ||
      (hv === 'invited' && membership === 'invite')
    ? 'visible'
    : ['joined', 'invited', 'world_readable'].includes(String(hv))
    ? 'hidden'
    : 'shared';
}
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
      contents.set(id, contentOf(row));
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
    const decision = visibility(state.hv, state.membership);
    if (decision === 'visible') return true;
    // Shared (including unknown values) needs a qualifying join at the
    // event or later. A current invite/leave/ban row proves neither.
    shared ||= decision === 'shared';
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

/** Same event-local policy, with read sets collected in the held room view. */
export async function visibleEventsAt(
  userId: string,
  tx: RoomTx,
  events: ReadonlyMap<string, EventRow>,
  statuses: ReadonlyMap<string, Status>,
  refs: Awaited<ReturnType<RoomTx['state']['eventStateRefs']>>,
): Promise<Set<string>> {
  const visible = new Set<string>();
  const groupsPerEvent = new Map<string, number[]>();
  const groups = new Set<number>();
  for (const [id, event] of events) {
    const status = statuses.get(id);
    if (status?.standing !== 'accepted' || status.grounding !== 'grounded') {
      continue;
    }
    if (event.type === 'm.room.member' && event.state_key === userId) {
      visible.add(id);
      continue;
    }
    const ref = refs.get(id);
    if (!ref?.before || !ref.after) continue;
    const wanted = event.type === 'm.room.history_visibility'
      ? [ref.after.group, ref.before.group]
      : [ref.after.group];
    groupsPerEvent.set(id, wanted);
    for (const group of wanted) groups.add(group);
  }
  const keys: GroupKey[] = [...groups].flatMap((group): GroupKey[] => [
    [group, 'm.room.history_visibility', ''],
    [group, 'm.room.member', userId],
  ]);
  const ids = await tx.state.groupKeys(keys);
  const pdus = await tx.events.list([
    ...new Set(ids.flatMap((id) => id === null ? [] : [id])),
  ]);
  const content = (id: string | null) =>
    contentOf(id === null ? undefined : pdus.get(id));
  const decisions = new Map(
    [...groups].map((
      group,
      n,
    ) => [
      group,
      visibility(
        content(ids[2 * n]).history_visibility,
        content(ids[2 * n + 1]).membership,
      ),
    ]),
  );
  const shared: string[] = [];
  for (const [id, wanted] of groupsPerEvent) {
    if (wanted.some((group) => decisions.get(group) === 'visible')) {
      visible.add(id);
    } else if (wanted.some((group) => decisions.get(group) === 'shared')) {
      shared.push(id);
    }
  }
  const publications = await tx.state.publishedGroupsAfterMany(shared);
  const laterGroups = [...new Set([...publications.values()].flat())];
  const memberships = await tx.state.groupKeys(
    laterGroups.map((group) => [group, 'm.room.member', userId]),
  );
  const members = await tx.events.list([
    ...new Set(memberships.flatMap((id) => id === null ? [] : [id])),
  ]);
  const joined = new Set(laterGroups.filter((_, n) => {
    const member = memberships[n];
    return member !== null &&
      contentOf(members.get(member)).membership === 'join';
  }));
  for (const [id, later] of publications) {
    if (later.some((group) => joined.has(group))) visible.add(id);
  }
  return visible;
}
