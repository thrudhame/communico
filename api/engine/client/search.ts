import { theApp } from '#engine/app.ts';
import { isIgnoredEvent } from './ignored.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  matchTokens,
  rankOf,
  SEARCH_KEYS,
  type SearchCandidate,
  searchCandidates,
} from '#engine/server/read.ts';
import { purgeable } from '#engine/server/directory.ts';
import {
  eventMatchesRoomEventFilter,
  type RoomEventFilter,
  roomEventFilterOf,
} from '#engine/tenant/filters.ts';
import { joinedRooms } from './membership.ts';
import { lookupRoom, requireRoom, stateAtSeq } from './room.ts';
import { admitState } from './state-admission.ts';
import { renderEvent } from './render.ts';
import { messages, parseStreamToken } from './timeline.ts';
import { clientEventsForRows, clientStateFor } from './state.ts';
import { canSeeEvent } from './visibility.ts';
import { erasurePrunes } from '#engine/erasure.ts';
export interface SearchRoomEvents {
  search_term: string;
  keys?: unknown;
  filter?: unknown;
  order_by?: unknown;
  event_context?: unknown;
  include_state?: unknown;
  groupings?: unknown;
}
type Hit = SearchCandidate & { rank: number };
async function roomScope(user: string, filter: RoomEventFilter) {
  const joined = await joinedRooms(user),
    set = new Set(joined),
    excluded = new Set(filter.not_rooms ?? []);
  const out = new Set(
    (filter.rooms ?? joined).filter((r) => set.has(r) && !excluded.has(r)),
  );
  for (const start of filter.rooms ?? joined) {
    let current: string | null = start;
    const seen = new Set<string>();
    for (let hop = 0; current !== null && hop < 32; hop++) {
      if (seen.has(current)) break;
      seen.add(current);
      if (await lookupRoom(current) === null) break;
      const create = (await stateAtSeq(current, null)).find((r) =>
        r.type === 'm.room.create' && r.stateKey === ''
      );
      const pred = create?.content.predecessor as
        | { room_id?: unknown }
        | undefined;
      const next = typeof pred?.room_id === 'string' ? pred.room_id : null;
      if (next === null || await purgeable(theApp().server, next)) break;
      if (set.has(next) && !excluded.has(next)) out.add(next);
      current = next;
    }
  }
  return [...out];
}
export async function search(
  userId: string,
  deviceId: string | null,
  req: SearchRoomEvents,
  nextBatch: string | null,
) {
  const tokens = req.search_term.toLowerCase().split(/\s+/).filter(Boolean),
    filter = roomEventFilterOf(req.filter);
  const keys = Array.isArray(req.keys)
    ? req.keys.filter((k): k is string =>
      typeof k === 'string' && SEARCH_KEYS.includes(k)
    )
    : [...SEARCH_KEYS];
  const recent = req.order_by === 'recent',
    limit = filter.limit ?? 10,
    groups: string[] = [];
  if (
    req.groupings !== null && typeof req.groupings === 'object' &&
    !Array.isArray(req.groupings)
  ) {
    const list = (req.groupings as Record<string, unknown>).group_by;
    if (Array.isArray(list)) {
      for (const g of list) {
        const key = g !== null && typeof g === 'object'
          ? (g as Record<string, unknown>).key
          : undefined;
        if (typeof key !== 'string') continue;
        if (key !== 'room_id' && key !== 'sender') {
          throw new MatrixError(
            400,
            'M_INVALID_PARAM',
            'bad group key: ' + key,
          );
        }
        groups.push(key);
      }
    }
  }
  let before: number | null = null;
  if (nextBatch !== null) {
    const token = parseStreamToken(nextBatch);
    if (token === null) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'bad next_batch');
    }
    if (recent) before = token.eSeq;
  }
  const rooms = await roomScope(userId, filter);
  if (rooms.length === 0 || keys.length === 0) {
    return { count: 0, results: [], highlights: tokens };
  }
  const matched: Hit[] = [];
  // roomScope owns predecessor expansion and exclusions. Apply the same
  // resolved scope to event filtering, not the unexpanded request room list.
  const eventFilter = { ...filter, rooms };
  for (const c of await searchCandidates(theApp().server, rooms, keys)) {
    if (!matchTokens(c.bodyLower, tokens)) continue;
    const room = await lookupRoom(c.roomId);
    if (room === null) continue;
    const row = await room.tx((tx) => tx.events.get(c.eventId));
    if (row === null) continue;
    const pdu = JSON.parse(row.pdu);
    if (
      await erasurePrunes(room, c.eventId, pdu, { userId }, theApp().tenant)
    ) continue;
    if (
      !eventMatchesRoomEventFilter(
        null,
        { ...pdu, room_id: c.roomId },
        eventFilter,
      ) ||
      !await canSeeEvent(userId, room, c.eventId) ||
      await isIgnoredEvent(room, c.eventId, {
        userId,
        deviceId: null,
        tenant: theApp().tenant,
      })
    ) continue;
    matched.push({ ...c, rank: rankOf(c.bodyLower, tokens) });
  }
  const count = matched.length;
  const page = recent
    ? matched.filter((h) => before === null || h.seq < before).slice(0, limit)
    : matched.sort((a, b) => b.rank - a.rank || b.seq - a.seq).slice(0, limit);
  const results: Record<string, unknown>[] = [];
  for (const hit of page) {
    const room = (await lookupRoom(hit.roomId))!;
    const ev = await renderEvent(room, hit.eventId, {
      userId,
      deviceId,
      tenant: theApp().tenant,
    });
    if (ev === null) continue;
    let context: Record<string, unknown> = {};
    if (
      req.event_context !== null && typeof req.event_context === 'object' &&
      !Array.isArray(req.event_context)
    ) {
      const ctx = req.event_context as Record<string, unknown>,
        n = (v: unknown) =>
          typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 5;
      const common = {
        roomId: hit.roomId,
        userId,
        deviceId,
        leaveAt: null,
        toToken: null,
        lazyLoadMembers: false,
      };
      const b = await messages({
          ...common,
          dir: 'b',
          fromToken: 's' + (hit.seq - 1),
          limit: n(ctx.before_limit),
        }),
        a = await messages({
          ...common,
          dir: 'f',
          fromToken: 's' + hit.seq,
          limit: n(ctx.after_limit),
        });
      context = { events_before: b.chunk, events_after: a.chunk };
      if (b.end !== undefined) context.start = b.end;
      if (a.end !== undefined) context.end = a.end;
      if (ctx.include_profile === true) {
        const senders = new Set([
          hit.sender,
          ...b.chunk.map((e) => String(e.sender)),
          ...a.chunk.map((e) => String(e.sender)),
        ]);
        let atSeq = hit.seq;
        if (a.chunk.length > 0) {
          const last = a.chunk[a.chunk.length - 1].event_id;
          const seq = await theApp().server.query(
            'SELECT seq FROM feed WHERE event=?',
            [String(last)],
          );
          if (seq.length > 0) atSeq = Number(seq[0].seq);
        }
        const admission = await admitState(await requireRoom(hit.roomId), {
          userId,
          point: { seq: atSeq },
        });
        const state = await clientEventsForRows(
            hit.roomId,
            admission.rows.filter((r) =>
              r.type === 'm.room.member' && senders.has(r.stateKey)
            ),
            userId,
            { admission },
          ),
          profiles: Record<string, Record<string, unknown>> = {};
        for (const sender of senders) {
          const content = state.find((r) =>
            r.type === 'm.room.member' && r.state_key === sender
          )?.content as Record<string, unknown> ?? {};
          const p: Record<string, unknown> = {};
          for (const k of ['displayname', 'avatar_url']) {
            if (typeof content[k] === 'string') {
              p[k] = content[k];
            }
          }
          profiles[sender] = p;
        }
        context.profile_info = profiles;
      }
    }
    results.push({ rank: hit.rank, result: ev, context });
  }
  const out: Record<string, unknown> = { count, highlights: tokens, results };
  if (recent && page.length >= limit && page.length > 0) {
    out.next_batch = `s${page[page.length - 1].seq}_p0_t0_r0_a0`;
  }
  if (req.include_state === true) {
    const state: Record<string, unknown> = {};
    for (const roomId of new Set(page.map((h) => h.roomId))) {
      state[roomId] = await clientStateFor(roomId, userId);
    }
    out.state = state;
  }
  if (groups.length > 0) {
    const grouped: Record<
      string,
      Record<string, { results: string[]; order: number }>
    > = {};
    for (const key of groups) {
      const inner: Record<string, { results: string[]; order: number }> = {};
      for (const hit of page) {
        const value = key === 'room_id' ? hit.roomId : hit.sender;
        if (inner[value] === undefined) {
          inner[value] = { results: [], order: recent ? hit.seq : hit.rank };
        }
        inner[value].results.push(hit.eventId);
      }
      grouped[key] = inner;
    }
    out.groups = grouped;
  }
  return out;
}
