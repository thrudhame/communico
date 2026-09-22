// api/engine/search.ts — POST /_matrix/client/v3/search (search.yaml at
// v1.16). Matching is in JS (D2); the SQL only scopes by room and key.
import { serverDb, withDb } from './db.ts';
import {
  eventIndexRow,
  formatStreamToken,
  joinedRooms,
  lookupRoom,
  parseStreamToken,
  stateAtSeq,
  type StateRow,
} from './room.ts';
import { canSeeEvent } from './visibility.ts';
import { clientEventForRow, messages, pduById } from './timeline.ts';
import { clientEventsForRows } from './stateops.ts';
import {
  eventMatchesRoomEventFilter,
  type RoomEventFilter,
  roomEventFilterOf,
} from './filters.ts';
import { MatrixError } from './matrix-error.ts';
import { type EventIndexRow, eventIndexRowOf } from './event-format.ts';

const INDEX_KEYS = ['content.body', 'content.name', 'content.topic'];
const GROUP_KEYS = new Set(['room_id', 'sender']);
const PREDECESSOR_HOPS = 32;

export interface SearchRoomEvents {
  search_term: string;
  keys?: unknown;
  filter?: unknown;
  order_by?: unknown;
  event_context?: unknown;
  include_state?: unknown;
  groupings?: unknown;
}

interface Candidate {
  eventId: string;
  roomId: string;
  seq: number;
  sender: string;
  bodyLower: string;
  row: EventIndexRow;
}

interface Hit extends Candidate {
  rank: number;
}

interface EventContextReq {
  beforeLimit: number;
  afterLimit: number;
  includeProfile: boolean;
}

export async function search(
  userId: string,
  deviceId: string | null,
  req: SearchRoomEvents,
  nextBatch: string | null,
): Promise<Record<string, unknown>> {
  const tokens = req.search_term.toLowerCase().split(/\s+/).filter(Boolean);
  const highlights = tokens;
  const filter = roomEventFilterOf(req.filter);
  const keys = keysOf(req.keys);
  const orderBy = req.order_by === 'recent' ? 'recent' as const : 'rank';
  const groupBy = groupByOf(req.groupings);
  const limit = filter.limit ?? 10;

  let beforeSeq: number | null = null;
  if (nextBatch !== null) {
    const tok = parseStreamToken(nextBatch);
    if (tok === null) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'bad next_batch');
    }
    if (orderBy === 'recent') beforeSeq = tok.eSeq;
  }

  const rooms = await roomScope(userId, filter);
  if (rooms.length === 0 || keys.length === 0) {
    return { count: 0, results: [], highlights };
  }

  const raw = await candidates(rooms, keys);
  const matched: Hit[] = [];
  for (const c of raw) {
    if (c.row.redacted_by != null) continue;
    if (!matchTokens(c.bodyLower, tokens)) continue;
    const room = await lookupRoom(c.roomId);
    if (!room) continue;
    const pdu = await pduById(room.dbName, c.row.commit_hash, c.eventId);
    if (!pdu) continue;
    if (!eventMatchesRoomEventFilter(c.row, pdu, filter)) continue;
    if (
      !(await canSeeEvent(userId, c.roomId, {
        seq: c.seq,
        type: pdu.type,
        stateKey: pdu.state_key,
      }))
    ) {
      continue;
    }
    matched.push({ ...c, rank: rankOf(c.bodyLower, tokens) });
  }

  const count = matched.length;
  const page = orderBy === 'recent'
    ? pageRecent(matched, limit, beforeSeq)
    : pageRank(matched, limit);

  const results: Record<string, unknown>[] = [];
  const ctxReq = eventContextOf(req.event_context);
  for (const hit of page) {
    const room = await lookupRoom(hit.roomId);
    if (!room) continue;
    const ev = await clientEventForRow(
      room.dbName,
      room.roomVersion,
      hit.row,
      { userId, deviceId },
    );
    if (!ev) continue;
    results.push({
      rank: hit.rank,
      result: ev,
      context: ctxReq === null
        ? {}
        : await contextFor(hit, userId, deviceId, ctxReq),
    });
  }

  const out: Record<string, unknown> = { count, highlights, results };
  if (orderBy === 'recent' && page.length >= limit && page.length > 0) {
    out.next_batch = formatStreamToken(page[page.length - 1].seq, 0);
  }
  if (req.include_state === true) {
    out.state = await stateFor([...new Set(page.map((h) => h.roomId))]);
  }
  if (groupBy.length > 0) out.groups = groupsFor(page, groupBy, orderBy);
  return out;
}

function keysOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...INDEX_KEYS];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k === 'string' && INDEX_KEYS.includes(k)) out.push(k);
  }
  return out;
}

function groupByOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }
  const gb = (raw as Record<string, unknown>).group_by;
  if (!Array.isArray(gb)) return [];
  const out: string[] = [];
  for (const g of gb) {
    if (g === null || typeof g !== 'object' || Array.isArray(g)) continue;
    const key = (g as Record<string, unknown>).key;
    if (typeof key !== 'string') continue;
    if (!GROUP_KEYS.has(key)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'bad group key: ' + key);
    }
    out.push(key);
  }
  return out;
}

function eventContextOf(raw: unknown): EventContextReq | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d;
  return {
    beforeLimit: n(r.before_limit, 5),
    afterLimit: n(r.after_limit, 5),
    includeProfile: r.include_profile === true,
  };
}

async function roomScope(
  userId: string,
  filter: RoomEventFilter,
): Promise<string[]> {
  const joined = await joinedRooms(userId);
  const joinedSet = new Set(joined);
  const notRooms = new Set(filter.not_rooms ?? []);
  const listed = filter.rooms;
  const out = new Set(
    (listed !== undefined ? listed.filter((r) => joinedSet.has(r)) : joined)
      .filter((r) => !notRooms.has(r)),
  );
  const walkFrom = listed !== undefined ? listed : joined;
  for (const roomId of walkFrom) {
    await walkPredecessors(roomId, joinedSet, notRooms, out);
  }
  return [...out];
}

async function walkPredecessors(
  start: string,
  joined: Set<string>,
  notRooms: Set<string>,
  out: Set<string>,
): Promise<void> {
  const seen = new Set<string>();
  let current: string | null = start;
  let hops = 0;
  while (current !== null && hops < PREDECESSOR_HOPS) {
    if (seen.has(current)) {
      console.error('search: predecessor cycle at', current);
      return;
    }
    seen.add(current);
    hops++;
    const rows: StateRow[] = (await stateAtSeq(current, null)) ?? [];
    const create = rows.find((r) =>
      r.type === 'm.room.create' && r.stateKey === ''
    );
    const pred = ((create?.content ?? {}) as {
      predecessor?: { room_id?: unknown };
    }).predecessor;
    const next: string | null = pred !== null && typeof pred === 'object' &&
        typeof pred.room_id === 'string'
      ? pred.room_id
      : null;
    if (next === null) return;
    if (joined.has(next) && !notRooms.has(next)) out.add(next);
    current = next;
  }
  if (current !== null) {
    console.error(
      'search: predecessor walk hit',
      PREDECESSOR_HOPS,
      'hops from',
      start,
    );
  }
}

async function candidates(
  rooms: string[],
  keys: string[],
): Promise<Candidate[]> {
  return await withDb(serverDb(), async (c) => {
    const sql =
      `SELECT si.event_id, si.room_id, si.seq, si.key, si.sender, si.origin_ts, si.body_lower,
                ei.redacted_by, ei.commit_hash, ei.rejected, ei.soft_failed,
                ei.state_commit_hash, ei.txn_device, ei.txn_id
         FROM search_index si JOIN event_index ei ON ei.event_id = si.event_id
         WHERE si.room_id = ANY($1) AND si.key = ANY($2)
         ORDER BY si.seq DESC;`;
    const r = await c.query(sql, [rooms, keys]);
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      eventId: String(row.event_id),
      roomId: String(row.room_id),
      seq: Number(row.seq),
      sender: String(row.sender),
      bodyLower: String(row.body_lower),
      row: eventIndexRowOf(row),
    }));
  });
}

function matchTokens(bodyLower: string, tokens: string[]): boolean {
  return tokens.every((t) => bodyLower.includes(t));
}

function rankOf(bodyLower: string, tokens: string[]): number {
  const words = bodyLower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let occ = 0;
  for (const t of tokens) occ += countSubstr(bodyLower, t);
  return occ / words.length;
}

function countSubstr(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    n++;
    i = j + needle.length;
  }
  return n;
}

function pageRecent(
  hits: Hit[],
  limit: number,
  beforeSeq: number | null,
): Hit[] {
  const scoped = beforeSeq === null
    ? hits
    : hits.filter((h) => h.seq < beforeSeq);
  return scoped.slice(0, limit);
}

function pageRank(hits: Hit[], limit: number): Hit[] {
  const sorted = [...hits].sort((a, b) =>
    b.rank !== a.rank ? b.rank - a.rank : b.seq - a.seq
  );
  return sorted.slice(0, limit);
}

async function contextFor(
  hit: Hit,
  userId: string,
  deviceId: string | null,
  ctx: EventContextReq,
): Promise<Record<string, unknown>> {
  const before = await messages({
    roomId: hit.roomId,
    userId,
    deviceId,
    leaveAt: null,
    dir: 'b',
    fromSeq: hit.seq - 1,
    toSeq: null,
    limit: ctx.beforeLimit,
    lazyLoadMembers: false,
  });
  const after = await messages({
    roomId: hit.roomId,
    userId,
    deviceId,
    leaveAt: null,
    dir: 'f',
    fromSeq: hit.seq,
    toSeq: null,
    limit: ctx.afterLimit,
    lazyLoadMembers: false,
  });
  const context: Record<string, unknown> = {
    events_before: before.chunk,
    events_after: after.chunk,
  };
  if (before.end !== undefined) context.start = before.end;
  if (after.end !== undefined) context.end = after.end;
  if (ctx.includeProfile) {
    context.profile_info = await profilesFor(
      hit,
      before.chunk,
      after.chunk,
    );
  }
  return context;
}

async function profilesFor(
  hit: Hit,
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): Promise<Record<string, { displayname?: string; avatar_url?: string }>> {
  const senders = new Set<string>([hit.sender]);
  for (const e of [...before, ...after]) {
    if (typeof e.sender === 'string') senders.add(e.sender);
  }
  let atSeq = hit.seq;
  if (after.length > 0) {
    const lastId = after[after.length - 1].event_id;
    if (typeof lastId === 'string') {
      const idx = await eventIndexRow(hit.roomId, lastId);
      if (idx) atSeq = idx.seq;
    }
  }
  const state = (await stateAtSeq(hit.roomId, atSeq)) ?? [];
  const info: Record<string, { displayname?: string; avatar_url?: string }> =
    {};
  for (const sender of senders) {
    const row = state.find((r) =>
      r.type === 'm.room.member' && r.stateKey === sender
    );
    const content = (row?.content ?? {}) as {
      displayname?: unknown;
      avatar_url?: unknown;
    };
    const profile: { displayname?: string; avatar_url?: string } = {};
    if (typeof content.displayname === 'string') {
      profile.displayname = content.displayname;
    }
    if (typeof content.avatar_url === 'string') {
      profile.avatar_url = content.avatar_url;
    }
    info[sender] = profile;
  }
  return info;
}

async function stateFor(
  roomIds: string[],
): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const roomId of roomIds) {
    const room = await lookupRoom(roomId);
    if (!room) continue;
    const rows = (await stateAtSeq(roomId, null)) ?? [];
    out[roomId] = await clientEventsForRows(
      room.dbName,
      roomId,
      rows,
      room.roomVersion,
    );
  }
  return out;
}

function groupsFor(
  page: Hit[],
  groupBy: string[],
  orderBy: 'rank' | 'recent',
): Record<string, Record<string, { results: string[]; order: number }>> {
  const groups: Record<
    string,
    Record<string, { results: string[]; order: number }>
  > = {};
  for (const key of groupBy) {
    const inner: Record<string, { results: string[]; order: number }> = {};
    for (const hit of page) {
      const value = key === 'room_id' ? hit.roomId : hit.sender;
      if (inner[value] === undefined) {
        inner[value] = {
          results: [],
          order: orderBy === 'recent' ? hit.seq : hit.rank,
        };
      }
      inner[value].results.push(hit.eventId);
    }
    groups[key] = inner;
  }
  return groups;
}
