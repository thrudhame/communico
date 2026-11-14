// A pinned semantic room manifest. Source positions identify retained chapters
// only while reading; no source group, segment, feed or publication ID escapes.
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room, Segment } from './index.ts';

export type ReplicaRoom = {
  version: 1;
  roomId: string;
  roomVersion: string;
  after: number;
  cut: number;
  stays: {
    opening: { kind: 'genesis' | 'join'; eventId: string; createId: string };
    closed: boolean;
  }[];
  steps: {
    kind: 'live' | 'history';
    eventId: string;
    stay: string;
    // An isolated history chapter is named by its authentic first event.
    anchor: string | null;
    origin: string;
  }[];
  events: Pdu[];
  boundaries: { eventId: string; state: string[]; authChain: string[] }[];
};

function unavailable(message: string): never {
  throw new MatrixError(503, 'M_UNAVAILABLE', message);
}

/** Freeze all retained participation and history in one room transaction. The
 * returned immutable bytes can be journaled before a later suffix is scanned.
 * Imported before-state is retained for every gap, not just the latest join.
 * The changes log is the source mutation intent and the cut is only a source
 * watermark, never a destination stream position. */
export function exportReplicaRoom(
  room: Room,
  self: string,
  after = 0,
): Promise<ReplicaRoom> {
  return room.tx(async (tx) => {
    const cut = await tx.changes.head();
    if (!Number.isSafeInteger(after) || after < 0 || after > cut) {
      unavailable('replica source cut is unavailable');
    }
    const changes = cut === after
      ? []
      : await tx.changes.after(after, cut - after);
    const segments = await tx.segments.list();
    const bySegment = new Map(segments.map((segment) => [segment.id, segment]));
    const pack = new Map<string, Pdu>();
    const read = async (id: string): Promise<Pdu> => {
      const held = pack.get(id);
      if (held) return held;
      const row = await tx.events.get(id);
      if (!row) unavailable('required replica event is not retained');
      const pdu = JSON.parse(row.pdu) as Pdu;
      pack.set(id, pdu);
      return pdu;
    };
    for (const change of changes) {
      if (change.event !== null) await read(change.event);
    }
    const stays: ReplicaRoom['stays'] = [];
    const stayKeys = new Map<number, string>();
    let roomVersion: string | undefined;
    for (
      const segment of segments.filter((segment) => segment.kind === 'stay')
    ) {
      let joinId = segment.opened_by;
      let createId: string;
      if (joinId === null) {
        // Locally created genesis has exactly create -> creator join. Those
        // authentic events name this stay, not a new fabricated join.
        const first = await tx.segments.positionsPage(
          segment.id,
          Number.MIN_SAFE_INTEGER,
          'f',
          2,
        );
        if (first.length !== 2) unavailable('replica genesis is not retained');
        const create = await read(first[0].event);
        const join = await read(first[1].event);
        if (
          create.type !== 'm.room.create' || create.state_key !== '' ||
          domainOf(create.sender) !== self || join.type !== 'm.room.member' ||
          join.state_key !== join.sender || domainOf(join.sender) !== self ||
          join.content?.membership !== 'join' ||
          join.prev_events?.length !== 1 ||
          join.prev_events[0] !== first[0].event
        ) unavailable('replica has no authentic local genesis');
        createId = first[0].event;
        joinId = first[1].event;
      } else {
        const join = await read(joinId);
        const before = await tx.state.eventStateBefore(joinId);
        if (
          !before || join.type !== 'm.room.member' ||
          join.state_key !== join.sender || domainOf(join.sender) !== self ||
          join.content?.membership !== 'join'
        ) unavailable('replica participation evidence is not retained');
        const state = await tx.state.groupMap(before.group);
        const id = state.get('m.room.create\0');
        if (!id) unavailable('replica room create is not retained');
        createId = id;
      }
      const create = await read(createId);
      const version = create.content?.room_version;
      if (
        typeof version !== 'string' || (roomVersion && roomVersion !== version)
      ) {
        unavailable('replica room version is inconsistent');
      }
      roomVersion = version;
      stayKeys.set(segment.id, joinId);
      stays.push({
        opening: {
          kind: segment.opened_by === null ? 'genesis' : 'join',
          eventId: joinId,
          createId,
        },
        closed: segment.status === 'closed',
      });
    }
    if (!roomVersion || stays.length === 0) {
      unavailable('replica participation is unavailable');
    }
    const steps: ReplicaRoom['steps'] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      if (
        change.event === null ||
        !['event', 'transition', 'history'].includes(change.kind)
      ) continue;
      const data = JSON.parse(change.data);
      if (data.grounding !== 'grounded') continue;
      const history = change.kind === 'history';
      const segment: Segment | undefined = bySegment.get(
        history ? data.segment : data.stay,
      );
      const stay = segment?.kind === 'stay' ? segment.id : segment?.prev;
      const key = stay === null || stay === undefined
        ? undefined
        : stayKeys.get(stay);
      if (!segment || !key) {
        unavailable('replica event has no retained participation');
      }
      const identity = (history ? 'history:' : 'live:') + change.event;
      if (seen.has(identity)) continue;
      seen.add(identity);
      steps.push({
        kind: history ? 'history' : 'live',
        eventId: change.event,
        stay: key,
        anchor: segment.kind === 'anchor' ? segment.opened_by : null,
        origin: typeof data.origin === 'string' ? data.origin : self,
      });
    }
    const boundaries: ReplicaRoom['boundaries'] = [];
    const openings = new Set(
      stays.filter((stay) => stay.opening.kind === 'join').map((stay) =>
        stay.opening.eventId
      ),
    );
    for (const id of [...pack.keys()]) {
      const before = await tx.state.eventStateBefore(id);
      if (
        before === null ||
        (before.provenance !== 'imported' && !openings.has(id))
      ) continue;
      const state = [
        ...new Set((await tx.state.groupMap(before.group)).values()),
      ].sort();
      const closure = new Set<string>();
      const queue = [...state, ...((await read(id)).auth_events ?? [])];
      for (let i = 0; i < queue.length; i++) {
        const auth = queue[i];
        if (closure.has(auth)) continue;
        closure.add(auth);
        queue.push(...((await read(auth)).auth_events ?? []));
      }
      boundaries.push({ eventId: id, state, authChain: [...closure].sort() });
    }
    // Include complete retained auth closure, even for unpositioned evidence.
    const queue = [...pack.keys()];
    for (let i = 0; i < queue.length; i++) {
      for (const id of (await read(queue[i])).auth_events ?? []) {
        if (!pack.has(id)) {
          await read(id);
          queue.push(id);
        }
      }
    }
    return {
      version: 1,
      roomId: room.id,
      roomVersion,
      after,
      cut,
      stays,
      steps,
      events: [...pack].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map((
        [, pdu],
      ) => pdu),
      boundaries,
    };
  });
}
