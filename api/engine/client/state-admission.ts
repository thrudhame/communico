// One disclosure contract for state snapshots. Raw room reads are not grants.
// Authorized snapshots include old/imported keys; unadmitted snapshots fall
// back to event visibility, never to "there is a membership row".
import { theApp } from '#engine/app.ts';
import type { Room } from '#engine/room/index.ts';
import { membershipOf } from '#engine/server/read.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { canSeeEventAt } from './visibility.ts';
import type { StateRow } from './read.ts';

export type StatePoint = { seq: number; stay?: number } | { eventId: string };
export type StateAdmission = {
  roomId: string;
  userId: string | null;
  events: ReadonlySet<string>;
  rows: StateRow[];
  seq: number;
};
const discoveryTypes = new Set([
  'm.room.create',
  'm.room.name',
  'm.room.topic',
  'm.room.canonical_alias',
  'm.room.history_visibility',
  'm.room.guest_access',
  'm.room.join_rules',
  'm.room.avatar',
  'm.room.encryption',
  'm.space.child',
]);

export async function admitState(
  room: Room,
  input: {
    userId: string | null;
    point?: StatePoint;
    ceiling?: number;
    allowInvited?: boolean;
    discovery?: boolean;
  },
): Promise<StateAdmission> {
  const events = new Set<string>();
  const grant: StateAdmission = {
    roomId: room.id,
    userId: input.userId,
    events,
    rows: [],
    seq: 0,
  };
  if (input.userId === null && !input.discovery) return grant;
  const app = theApp();
  const member = input.userId === null
    ? null
    : await membershipOf(app.server, room.id, input.userId);
  if (!input.discovery && member?.forgotten) return grant;
  let ceiling = input.ceiling ?? await eventStreamMax(app.server);
  if (!input.discovery && member !== null && member.membership !== 'join') {
    ceiling = Math.min(ceiling, member.seq);
  }
  grant.seq = ceiling;
  const cut = await app.server.query(
    'SELECT pos,stay FROM feed WHERE room=? AND seq<=? ORDER BY seq DESC LIMIT 1',
    [room.id, ceiling],
  );
  const point = input.point ?? { seq: ceiling };
  const selected = 'seq' in point
    ? await app.server.query(
      'SELECT pos,stay FROM feed WHERE room=? AND seq<=? ORDER BY seq DESC LIMIT 1',
      [room.id, Math.min(point.seq, ceiling)],
    )
    : [];
  const event = 'eventId' in point ? point.eventId : null;
  if (event !== null) {
    const live = await app.server.query(
      'SELECT seq FROM feed WHERE room=? AND event=?',
      [room.id, event],
    );
    if (live.length && Number(live[0].seq) > ceiling) return grant;
  }
  const participation = input.discovery || input.userId === null || !cut.length
    ? null
    : await room.tx((tx) =>
      tx.state.participationAt(
        input.userId!,
        Number(cut[0].pos),
        Number(cut[0].stay),
      )
    );
  const boundary = participation?.departure;
  const departed = boundary === undefined || boundary === null
    ? []
    : await app.server.query(
      'SELECT seq FROM feed WHERE room=? AND pos<=? ORDER BY pos DESC LIMIT 1',
      [room.id, boundary.pos],
    );
  if (departed.length) grant.seq = Math.min(grant.seq, Number(departed[0].seq));
  return await room.tx(async (tx) => {
    const stay = 'seq' in point
      ? point.stay ?? (selected.length ? Number(selected[0].stay) : null)
      : null;
    let group = event !== null
      ? (await tx.state.eventStateAfter(event))?.group ?? null
      : stay === null
      ? null
      : await tx.state.publishedAt(
        stay,
        selected.length && Number(selected[0].stay) === stay
          ? Number(selected[0].pos)
          : 0,
      );
    if (group === null) return grant;
    const original = await tx.state.groupMap(group);
    const pointPos = event === null
      ? selected.length ? Number(selected[0].pos) : 0
      : await tx.changes.posOf(event) ?? 0;
    if (!input.discovery && boundary && pointPos > boundary.pos) {
      group = boundary.group;
    }
    const entries = group === boundary?.group
      ? await tx.state.groupMap(group)
      : original;
    if (input.discovery) {
      for (const [key, id] of entries) {
        if (discoveryTypes.has(key.split('\0')[0])) events.add(id);
      }
    } else {
      const user = input.userId!;
      const content = async (type: string, key: string) => {
        const id = await tx.state.groupKey(group, type, key);
        const row = id === null ? null : await tx.events.get(id);
        return row === null
          ? {}
          : JSON.parse(row.pdu).content as Record<string, unknown>;
      };
      const membership = (await content('m.room.member', user)).membership;
      const raw =
        (await content('m.room.history_visibility', '')).history_visibility;
      const visibility =
        ['joined', 'invited', 'world_readable'].includes(String(raw))
          ? raw
          : 'shared';
      const joinedAtPoint = await tx.state.hasJoinedBefore(
        user,
        Math.min(pointPos, boundary?.pos ?? pointPos),
      );
      // Snapshot admission, not the creation-time visibility of each old state key.
      // Declined invitations do not satisfy any joined-history branch.
      const full = membership === 'join' || visibility === 'world_readable' ||
        (membership === 'invite' &&
          (visibility === 'invited' ||
            (input.allowInvited && member?.membership === 'invite' &&
              visibility !== 'joined'))) ||
        (participation !== null && visibility === 'shared') ||
        (joinedAtPoint && (membership === 'leave' || membership === 'ban'));
      for (const id of entries.values()) {
        if (full || await canSeeEventAt(user, tx, id, group)) events.add(id);
      }
      const ownKey = 'm.room.member\0' + user;
      const own = original.get(ownKey);
      if (own !== undefined && await canSeeEventAt(user, tx, own, group)) {
        entries.set(ownKey, own);
        events.add(own);
      }
    }
    for (const [key, id] of entries) {
      if (!events.has(id)) continue;
      const row = await tx.events.get(id);
      if (row === null) continue;
      const pdu = JSON.parse(row.pdu);
      const sep = key.indexOf('\0');
      grant.rows.push({
        type: key.slice(0, sep),
        stateKey: key.slice(sep + 1),
        eventId: id,
        content: pdu.content ?? {},
        sender: pdu.sender,
        originTs: pdu.origin_server_ts,
      });
    }
    return grant;
  });
}
