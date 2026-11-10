import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { backfill, bridgeForwardAnchor } from '#engine/room/history.ts';
import {
  formatCursor,
  parseCursor,
  type Room,
  type WalkCursor,
} from '#engine/room/index.ts';
import { membershipOf } from '#engine/server/read.ts';
import {
  eventMatchesRoomEventFilter,
  type RoomEventFilter,
  roomEventFilterOf,
} from '#engine/tenant/filters.ts';
import { serversInRoom } from './membership.ts';
import { renderEvent } from './render.ts';
import { requireRoom, type StateRow } from './room.ts';
import { clientEventsForRows } from './state.ts';
import { canSeeEvent } from './visibility.ts';

import { parseStreamToken } from './tokens.ts';
export { parseStreamToken } from './tokens.ts';

export async function cursorForToken(
  room: Room,
  token: string,
  dir: 'b' | 'f',
): Promise<WalkCursor | null> {
  const cursor = parseCursor(token);
  if (cursor !== null) return cursor;
  const stream = parseStreamToken(token);
  if (stream === null) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unknown pagination token: ' + token,
    );
  }
  const rows = await theApp().server.query(
    'SELECT event FROM feed WHERE room = ? AND seq <= ? ORDER BY seq DESC LIMIT 1',
    [room.id, stream.eSeq],
  );
  if (rows.length === 0) return null;
  const position = await room.tx((tx) =>
    tx.segments.positionOf(String(rows[0].event))
  );
  return position === null ? null : {
    segment: position.segment,
    offset: position.offset + (dir === 'b' ? 1 : 0),
  };
}

async function compare(room: Room, a: WalkCursor, b: WalkCursor) {
  return await room.tx(async (tx) => {
    const rank = async (c: WalkCursor) => {
      const s = await tx.segments.get(c.segment);
      return s === null ? [c.segment, 1, c.offset] : [
        s.kind === 'stay' ? s.id : s.prev!,
        s.kind === 'stay' ? 1 : 0,
        c.offset,
      ];
    };
    const x = await rank(a), y = await rank(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
}

export async function stateAtEvent(
  room: Room,
  eventId: string,
): Promise<StateRow[]> {
  return await room.tx(async (tx) => {
    const refs = await tx.state.eventReadState(eventId);
    if (refs === null) return [];
    const out: StateRow[] = [];
    for (const entry of await tx.state.groupEntries(refs.after.group)) {
      const row = entry.event === null
        ? null
        : await tx.events.get(entry.event);
      if (row !== null) {
        out.push({
          type: entry.type,
          stateKey: entry.state_key,
          eventId: row.id,
          content: JSON.parse(row.pdu).content ?? {},
        });
      }
    }
    return out;
  });
}

export type MessagesWindow = {
  roomId: string;
  userId: string;
  deviceId: string | null;
  leaveAt: number | null;
  dir: 'b' | 'f';
  fromToken: string | null;
  toToken: string | null;
  limit: number;
  lazyLoadMembers: boolean;
  containsUrl?: boolean;
  // Room previews never start a history fetch or change participation.
  localOnly?: boolean;
};
export async function messages(
  w: MessagesWindow,
): Promise<
  {
    chunk: Record<string, unknown>[];
    start: string;
    end?: string;
    state?: Record<string, unknown>[];
  }
> {
  const room = await requireRoom(w.roomId);
  const limit = Math.max(0, Math.floor(w.limit));
  const leave = w.leaveAt === null
    ? null
    : await cursorForToken(room, 's' + w.leaveAt, 'f');
  let cursor = w.fromToken === null
    ? null
    : await cursorForToken(room, w.fromToken, w.dir);
  if (cursor === null) {
    if (w.dir === 'b') {
      cursor = leave === null
        ? await room.tx((tx) => tx.segments.walkStart())
        : { ...leave, offset: leave.offset + 1 };
    } else {
      const segments = await room.tx((tx) => tx.segments.list());
      const first = segments.find((s) => s.kind === 'stay');
      const history = first === undefined
        ? null
        : await room.tx((tx) => tx.segments.historyOf(first.id));
      cursor = first === undefined ? null : {
        segment: history?.id ?? first.id,
        offset: -Number.MAX_SAFE_INTEGER,
      };
    }
  }
  if (cursor === null) return { chunk: [], start: w.fromToken ?? '' };
  const to = w.toToken === null
    ? null
    : await cursorForToken(room, w.toToken, w.dir);
  const raw: { event: string; cursor: WalkCursor }[] = [];
  let ended = false, filled = false;
  let frontier: WalkCursor | null = null;
  while (raw.length < limit) {
    const step = await room.tx((tx) => tx.segments.step(cursor!, w.dir));
    if (step.kind === 'end') {
      ended = true;
      break;
    }
    if (step.kind === 'gap') {
      if (w.localOnly) {
        frontier = step.cursor;
        break;
      }
      if (!filled) {
        filled = true;
        const signer = theApp().tenant.signer();
        await bridgeForwardAnchor(
          room,
          step.cursor,
          (await serversInRoom(room.id)).filter((s) => s !== serverName()),
          config().federation.backfillbatch,
          {
            keys: productionKeyResolver(theApp().server, signer),
            fetcher: productionFetcher(theApp().server, signer, theApp().store),
          },
        );
        const resolved = await room.tx((tx) =>
          tx.segments.step(cursor!, w.dir)
        );
        if (resolved.kind !== 'gap') continue;
      }
      frontier = step.cursor;
      break;
    }
    if (step.kind === 'frontier') {
      if (w.localOnly) {
        frontier = step.cursor;
        break;
      }
      if (filled) {
        frontier = step.cursor;
        break;
      }
      filled = true;
      const candidates = (await serversInRoom(room.id)).filter((s) =>
        s !== serverName()
      );
      const segment = await room.tx((tx) =>
        tx.segments.get(step.cursor.segment)
      );
      const stay = segment !== null && segment.kind !== 'stay'
        ? segment.prev!
        : step.cursor.segment;
      const signer = theApp().tenant.signer();
      let outcome = 'open';
      for (const via of candidates) {
        const res = await backfill(room, {
          from: step.prevs,
          limit: config().federation.backfillbatch,
          via,
          stay,
          segment: segment?.kind === 'anchor' ? segment.id : undefined,
        }, {
          keys: productionKeyResolver(theApp().server, signer),
          fetcher: productionFetcher(theApp().server, signer, theApp().store),
        });
        outcome = res.outcome;
        if (outcome !== 'open') break;
      }
      if (outcome === 'open') {
        frontier = step.cursor;
        break;
      }
      continue;
    }
    if (leave !== null && await compare(room, step.cursor, leave) > 0) {
      if (w.dir === 'f') break;
      cursor = step.cursor;
      continue;
    }
    if (to !== null) {
      const cmp = await compare(room, step.cursor, to);
      if ((w.dir === 'f' && cmp > 0) || (w.dir === 'b' && cmp <= 0)) break;
    }
    cursor = step.cursor;
    raw.push(step);
  }
  const chunk: Record<string, unknown>[] = [];
  let filtered = false;
  for (const row of raw) {
    const stored = await room.tx((tx) => tx.events.get(row.event));
    const content = stored === null ? {} : JSON.parse(stored.pdu).content ?? {};
    if (
      stored === null ||
      (w.containsUrl !== undefined &&
        (typeof content.url === 'string') !== w.containsUrl) ||
      !await canSeeEvent(w.userId, room, row.event)
    ) {
      filtered = true;
      continue;
    }
    const ev = await renderEvent(room, row.event, {
      userId: w.userId,
      deviceId: w.deviceId,
      tenant: theApp().tenant,
    });
    if (ev !== null) chunk.push(ev);
    else filtered = true;
  }
  const last = raw.length === 0
    ? null
    : await room.tx((tx) => tx.events.get(raw[raw.length - 1].event));
  const result: {
    chunk: Record<string, unknown>[];
    start: string;
    end?: string;
    state?: Record<string, unknown>[];
  } = { chunk, start: w.fromToken ?? '' };
  if (!((ended || last?.type === 'm.room.create') && !filtered)) {
    if (frontier !== null) result.end = formatCursor(frontier);
    else if (raw.length > 0 || limit === 0) result.end = formatCursor(cursor);
  }
  if (w.lazyLoadMembers) {
    const senders = new Set(chunk.map((e) => String(e.sender)));
    const anchor = w.dir === 'f' ? raw[raw.length - 1] : raw[0];
    const rows = anchor === undefined
      ? []
      : await stateAtEvent(room, anchor.event);
    result.state = await clientEventsForRows(
      room.id,
      rows.filter((r) => r.type === 'm.room.member' && senders.has(r.stateKey)),
    );
  }
  return result;
}

export async function eventFor(
  userId: string,
  deviceId: string | null,
  roomId: string,
  eventId: string,
) {
  const room = await requireRoom(roomId);
  if (!await canSeeEvent(userId, room, eventId)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  const event = await renderEvent(room, eventId, {
    userId,
    deviceId,
    tenant: theApp().tenant,
  });
  if (event === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  return event;
}

export async function eventContext(
  userId: string,
  deviceId: string | null,
  roomId: string,
  eventId: string,
  opts: { limit: number; filter: RoomEventFilter; lazyLoadMembers: boolean },
) {
  const room = await requireRoom(roomId);
  const event = await eventFor(userId, deviceId, roomId, eventId);
  const member = await membershipOf(theApp().server, roomId, userId);
  if (member?.forgotten) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'room forgotten: ' + roomId);
  }
  const pivot = await room.tx((tx) => tx.segments.positionOf(eventId));
  if (pivot === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  const window = {
    roomId,
    userId,
    deviceId,
    leaveAt: member === null || member.membership === 'join'
      ? null
      : member.seq,
    fromToken: formatCursor(pivot),
    toToken: null,
    lazyLoadMembers: false,
  };
  const before = await messages({
    ...window,
    dir: 'b',
    limit: Math.floor(opts.limit / 2),
  });
  const after = await messages({
    ...window,
    dir: 'f',
    limit: opts.limit - Math.floor(opts.limit / 2),
  });
  const matches = (e: Record<string, unknown>) =>
    eventMatchesRoomEventFilter(null, {
      type: String(e.type),
      sender: String(e.sender),
      room_id: roomId,
      content: e.content as Record<string, unknown>,
    }, opts.filter);
  const eventsBefore = before.chunk.filter(matches),
    eventsAfter = after.chunk.filter(matches);
  const at = eventsAfter.length > 0
    ? String(eventsAfter[eventsAfter.length - 1].event_id)
    : eventId;
  let state = (await clientEventsForRows(roomId, await stateAtEvent(room, at)))
    .filter(matches);
  if (opts.lazyLoadMembers) {
    const senders = new Set(
      [event, ...eventsBefore, ...eventsAfter].map((e) => String(e.sender)),
    );
    state = state.filter((e) =>
      e.type !== 'm.room.member' || senders.has(String(e.state_key))
    );
  }
  const result: Record<string, unknown> = {
    events_before: eventsBefore,
    event,
    events_after: eventsAfter,
    state,
  };
  if (before.end !== undefined) result.start = before.end;
  if (after.end !== undefined) result.end = after.end;
  return result;
}

export { roomEventFilterOf };
