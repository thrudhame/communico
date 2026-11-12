// Protocol selection over captured server/tenant owners. Timelines are hydrated
// by the room payload owner only after this module chooses the windows.
import { theApp } from '#engine/app.ts';
import { heldRoom, stateAtSeq } from '#engine/client/read.ts';
import { renderStateEvent } from '#engine/client/render.ts';
import { admitState } from '#engine/client/state-admission.ts';
import {
  prejoinDisplay,
  savedPrejoinDisplay,
} from '#engine/federation/prejoin.ts';
import { localpartOf } from '#engine/ids.ts';
import { inviteOf, prejoinDeparture } from '#engine/federation/invites.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room } from '#engine/room/index.ts';
import {
  type MembershipRow,
  slidingListSnapshot,
} from '#engine/server/read.ts';
import type { ListFilters, RoomConfig, SlidingRequest } from './types.ts';

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
export type ListCandidate = MembershipRow & {
  activity: number;
  cut: number;
  prejoin?: { event: Json; state: Json[] };
  departure?: Pdu;
};
export type ListSelection = {
  lists: Record<
    string,
    {
      count: number;
      ops: { op: 'SYNC'; range: [number, number]; room_ids: string[] }[];
    }
  >;
  rooms: Map<string, { candidate: ListCandidate; config: RoomConfig }>;
  listRooms: Map<string, Set<string>>;
};

export async function captureLists(userId: string) {
  const app = theApp();
  const server = await app.server.tx((tx) => slidingListSnapshot(tx, userId));
  const tenant = await app.tenant.tx((tx) =>
    tx.accountData.listSelection(localpartOf(userId))
  );
  return { ...server, ...tenant, userId };
}
type Snapshot = Awaited<ReturnType<typeof captureLists>>;

function rangesFor(
  ranges: [number, number][] | null,
  count: number,
): [number, number][] {
  if (ranges === null) return count ? [[0, count - 1]] : [];
  const merged: [number, number][] = [];
  for (const [a, b] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && a <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], b);
    } else merged.push([a, b]);
  }
  return merged;
}
function mergeConfig(a: RoomConfig | undefined, b: RoomConfig): RoomConfig {
  const tuples = new Map(
    (a?.requiredState ?? []).map((k) => [JSON.stringify(k), k]),
  );
  for (const key of b.requiredState) tuples.set(JSON.stringify(key), key);
  return {
    requiredState: [...tuples.values()],
    timelineLimit: Math.max(a?.timelineLimit ?? 0, b.timelineLimit),
  };
}

export async function selectLists(
  userId: string,
  request: SlidingRequest,
  options: {
    snapshot?: Snapshot;
    since?: number;
    previousRooms?: ReadonlySet<string>;
  } = {},
): Promise<ListSelection> {
  const result: ListSelection = {
    lists: Object.fromEntries(
      Object.keys(request.lists).map((name) => [name, { count: 0, ops: [] }]),
    ),
    rooms: new Map(),
    listRooms: new Map(),
  };
  if (
    !Object.keys(request.lists).length &&
    !Object.keys(request.subscriptions).length
  ) return result;
  const snapshot = options.snapshot ?? await captureLists(userId);
  if (snapshot.userId !== userId) {
    throw new Error('list snapshot owner mismatch');
  }
  const app = theApp(), viewer = { userId, deviceId: null, tenant: app.tenant };
  const ignored = new Set(
    Object.keys(object(object(snapshot.ignored).ignored_users)),
  );
  const dm = new Set(
    Object.values(object(snapshot.direct)).flatMap((v) =>
      Array.isArray(v)
        ? v.filter((id): id is string => typeof id === 'string')
        : []
    ),
  );
  const candidates = new Map<string, ListCandidate>();
  const unlisted = new Set<string>();
  const rooms = new Map<string, Room | null>();
  const roomFor = async (id: string) => {
    if (!rooms.has(id)) rooms.set(id, await heldRoom(id));
    return rooms.get(id)!;
  };
  for (const m of snapshot.memberships) {
    if (
      m.forgotten ||
      (m.membership !== 'join' && snapshot.purgeable.has(m.roomId))
    ) continue;
    if (!['join', 'invite', 'knock', 'leave', 'ban'].includes(m.membership)) {
      continue;
    }
    const cut = m.membership === 'join' ? snapshot.eventCut : m.seq;
    if (m.membership !== 'join') {
      const room = await roomFor(m.roomId);
      if (room === null) continue;
      const member = await room.tx((tx) => tx.events.get(m.eventId));
      if (member === null) continue;
      if (m.membership === 'invite' && ignored.has(member.sender)) continue;
      if (
        m.membership === 'leave' && member.sender === userId &&
        !(options.since !== undefined && m.seq > options.since) &&
        !options.previousRooms?.has(m.roomId)
      ) unlisted.add(m.roomId);
      if (m.membership === 'ban') {
        const feed = await app.server.query(
          'SELECT pos FROM feed WHERE room=? AND seq<=? ORDER BY seq DESC LIMIT 1',
          [m.roomId, m.seq],
        );
        const joined = feed.length !== 0 &&
          await room.tx((tx) =>
            tx.state.hasJoinedBefore(userId, Number(feed[0].pos))
          );
        if (!joined) continue;
      }
    }
    candidates.set(m.roomId, {
      ...m,
      cut,
      activity: Math.max(snapshot.activities.get(m.roomId) ?? 0, m.seq),
    });
  }
  for (const row of snapshot.prejoin) {
    if (
      ['joined', 'attempting', 'failed-attempt'].includes(String(row.status))
    ) continue;
    if (row.status !== 'pending') {
      const roomId = String(row.room_id), seq = Number(row.seq);
      if (
        !options.previousRooms?.has(roomId) &&
        !(options.since !== undefined && seq > options.since)
      ) continue;
      const departure = await prejoinDeparture(inviteOf(row), {
        server: app.server,
        signer: app.tenant.signer(),
      });
      if (departure !== null) {
        candidates.set(roomId, {
          roomId,
          membership: String(departure.content.membership),
          eventId: departure.event_id!,
          seq,
          forgotten: false,
          activity: seq,
          cut: seq,
          departure,
        });
      }
      continue;
    }
    const event = JSON.parse(String(row.event_json)) as Json;
    if (row.kind === 'invite' && ignored.has(String(event.sender))) continue;
    const roomId = String(row.room_id), seq = Number(row.seq);
    candidates.set(roomId, {
      roomId,
      membership: String(row.kind),
      eventId: String(row.event_id),
      seq,
      forgotten: false,
      activity: seq,
      cut: seq,
      prejoin: { event, state: JSON.parse(String(row.invite_room_state)) },
    });
  }
  // Read only requested metadata, cached per candidate/key. Saved prejoin data
  // never grants access to current private state, even for a held room.
  const cache = new Map<string, Promise<Json[]>>();
  const metadata = (
    c: ListCandidate,
    type: string,
    key = '',
  ): Promise<Json[]> => {
    const k = JSON.stringify([c.roomId, type, key]);
    if (!cache.has(k)) {
      cache.set(
        k,
        (async () => {
          const room = await roomFor(c.roomId);
          if (c.prejoin) {
            return (await savedPrejoinDisplay(
              room,
              c.prejoin.state,
              userId,
              viewer,
            ))
              .filter((e) =>
                e.type === type && (key === '*' || e.state_key === key)
              );
          }
          if (room === null) return [];
          if (c.membership === 'invite' || c.membership === 'knock') {
            // Prejoin display is its own stripped-state contract, not a full
            // private-state grant. Select its IDs at the captured membership cut.
            const rows = await stateAtSeq(room, c.cut, undefined, [[
              type,
              key,
            ]]);
            return await prejoinDisplay(
              room,
              rows.map((r) => r.eventId),
              userId,
              viewer,
            );
          }
          const admission = await admitState(room, {
            userId,
            point: { seq: c.cut },
            ceiling: c.cut,
            keys: [[type, key]],
          });
          const rows = admission.rows;
          const out: Json[] = [];
          for (const row of rows) {
            const shown = await renderStateEvent(room, row.eventId, viewer, {
              bundleThreads: false,
              admission,
            });
            if (shown !== null) out.push(shown);
          }
          return out;
        })(),
      );
    }
    return cache.get(k)!;
  };
  const content = async (c: ListCandidate, type: string) =>
    object((await metadata(c, type))[0]?.content);
  const matches = async (c: ListCandidate, f: ListFilters) => {
    if (f.is_dm !== undefined && f.is_dm !== dm.has(c.roomId)) return false;
    if (
      f.is_invite !== undefined && f.is_invite !== (c.membership === 'invite')
    ) return false;
    const tags = new Set(
      Object.keys(object(object(snapshot.tags.get(c.roomId)).tags)),
    );
    if (f.tags !== undefined && !f.tags.some((t) => tags.has(t))) return false;
    if (f.not_tags?.some((t) => tags.has(t))) return false;
    if (f.is_encrypted !== undefined) {
      const encrypted = (await metadata(c, 'm.room.encryption')).length > 0;
      if (encrypted !== f.is_encrypted) return false;
    }
    if (f.room_types !== undefined || f.not_room_types !== undefined) {
      const raw = (await content(c, 'm.room.create')).type;
      const type = typeof raw === 'string' ? raw : null;
      if (f.room_types !== undefined && !f.room_types.includes(type)) {
        return false;
      }
      if (f.not_room_types?.includes(type)) return false;
    }
    if (f.room_name_like !== undefined) {
      const name = (await content(c, 'm.room.name')).name;
      if (
        typeof name !== 'string' ||
        !name.toLowerCase().includes(f.room_name_like.toLowerCase())
      ) return false;
    }
    if (f.spaces !== undefined) {
      let found = false;
      for (const id of f.spaces) {
        const space = candidates.get(id);
        if (
          space?.membership !== 'join' ||
          (await content(space, 'm.room.create')).type !== 'm.space'
        ) continue;
        const child = (await metadata(space, 'm.space.child', c.roomId))[0];
        const via = object(child?.content).via;
        if (
          Array.isArray(via) && via.length &&
          via.every((v) => typeof v === 'string' && v.length > 0)
        ) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  };
  const ordered = [...candidates.values()].filter((c) =>
    !unlisted.has(c.roomId)
  ).sort((a, b) =>
    b.activity - a.activity ||
    (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)
  );
  const select = (c: ListCandidate, config: RoomConfig) =>
    result.rooms.set(c.roomId, {
      candidate: c,
      config: mergeConfig(result.rooms.get(c.roomId)?.config, config),
    });
  for (const [name, list] of Object.entries(request.lists)) {
    const matched: ListCandidate[] = [];
    for (const c of ordered) {
      if (await matches(c, list.filters)) matched.push(c);
    }
    const ops: ListSelection['lists'][string]['ops'] = [];
    const selected = new Set<string>();
    for (
      const range of rangesFor(
        list.allRooms ? null : list.ranges,
        matched.length,
      )
    ) {
      const window = matched.slice(range[0], range[1] + 1);
      ops.push({ op: 'SYNC', range, room_ids: window.map((c) => c.roomId) });
      for (const c of window) {
        selected.add(c.roomId);
        select(c, list);
      }
    }
    result.listRooms.set(name, selected);
    result.lists[name] = { count: matched.length, ops };
  }
  for (const [id, config] of Object.entries(request.subscriptions)) {
    const candidate = candidates.get(id);
    if (candidate) select(candidate, config);
  }
  return result;
}
