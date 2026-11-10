import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { threadRootsOf } from '#engine/server/read.ts';
import { type Room } from '#engine/room/index.ts';
import { stableCausalOrder } from '#engine/room/order.ts';
import { requireRoom } from './room.ts';
import { cursorForToken } from './timeline.ts';
import { renderEvent } from './render.ts';
import { canSeeEvent } from './visibility.ts';
import { relationView } from './relation-view.ts';

function invalid(message: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', message);
}
export function relationLimit(raw: string | null): number {
  if (raw === null) return 10;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    invalid('bad limit');
  }
  return Math.min(100, Number(raw));
}
function tokenFor(room: Room, event: string): string {
  return 'rel_' +
    btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(JSON.stringify([room.id, event])),
      ),
    ).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
type Bound = { event: string; inclusive: boolean } | 'before' | 'after' | null;
async function boundary(
  room: Room,
  raw: string | null,
  dir: 'b' | 'f',
): Promise<Bound> {
  if (raw === null) return null;
  if (raw.startsWith('rel_')) {
    let value;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(
            atob(raw.slice(4).replaceAll('-', '+').replaceAll('_', '/')),
            (c) => c.charCodeAt(0),
          ),
        ),
      );
    } catch {
      invalid('bad relation token');
    }
    if (
      !Array.isArray(value) || value.length !== 2 || value[0] !== room.id ||
      typeof value[1] !== 'string'
    ) invalid('bad relation token');
    const pos = await room.tx((tx) => tx.segments.positionOf(value[1]));
    if (pos === null) invalid('unknown relation token');
    return { event: value[1], inclusive: false };
  }
  const cursor = await cursorForToken(room, raw, dir);
  if (cursor === null) return 'before';
  const segment = await room.tx((tx) => tx.segments.get(cursor.segment));
  if (segment === null) invalid('unknown room cursor');
  const step = await room.tx((tx) => tx.segments.step(cursor, dir));
  if (step.kind === 'end') return dir === 'f' ? 'after' : 'before';
  if (step.kind !== 'event') {
    throw new MatrixError(
      503,
      'M_UNKNOWN',
      'pagination boundary is beyond held history',
    );
  }
  return { event: step.event, inclusive: true };
}

// Apply bounds in the same room-owned DAG order as the candidates. Decoding
// messages/sync cursors uses their real directional walk, not numeric coercion.
async function windowOf<T extends { event: string }>(
  room: Room,
  rows: T[],
  dir: 'b' | 'f',
  from: string | null,
  to: string | null,
): Promise<T[]> {
  const start = await boundary(room, from, dir),
    end = await boundary(room, to, dir);
  const ids = [
    ...new Set([
      ...rows.map((r) => r.event),
      ...(start !== null && typeof start === 'object' ? [start.event] : []),
      ...(end !== null && typeof end === 'object' ? [end.event] : []),
    ]),
  ];
  const order = await room.tx((tx) => stableCausalOrder(tx, ids));
  const rank = new Map(order.map((id, i) => [id, i]));
  const boundaryRank = (bound: Exclude<Bound, null>) =>
    bound === 'before'
      ? -Infinity
      : bound === 'after'
      ? Infinity
      : rank.get(bound.event)!;
  const sign = dir === 'f' ? 1 : -1;
  return rows.filter((row) => {
    const n = rank.get(row.event)!;
    if (start !== null) {
      const cmp = sign * (n - boundaryRank(start));
      if (
        cmp < 0 ||
        (cmp === 0 && (typeof start !== 'object' || !start.inclusive))
      ) return false;
    }
    if (end !== null) {
      const cmp = sign * (n - boundaryRank(end));
      if (cmp >= 0) return false;
    }
    return true;
  }).sort((a, b) => sign * (rank.get(a.event)! - rank.get(b.event)!));
}

export async function relationsPage(
  roomId: string,
  eventId: string,
  filters: { relType?: string; eventType?: string },
  query: {
    dir: string | null;
    limit: string | null;
    from: string | null;
    to: string | null;
    recurse: string | null;
  },
  viewer: string,
) {
  const dir = query.dir ?? 'b';
  if (dir !== 'b' && dir !== 'f') invalid('bad dir');
  if (
    query.recurse !== null && query.recurse !== 'true' &&
    query.recurse !== 'false'
  ) invalid('bad recurse');
  const limit = relationLimit(query.limit);
  const room = await requireRoom(roomId);
  if (!await canSeeEvent(viewer, room, eventId)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  const children = await relationView(room, eventId, viewer, {
    ...filters,
    recurse: query.recurse === 'true',
  });
  const window = await windowOf(
    room,
    children.map((r) => ({ event: r.eventId })),
    dir,
    query.from,
    query.to,
  );
  const slice = window.slice(0, limit);
  const chunk: Record<string, unknown>[] = [];
  for (const row of slice) {
    const event = await renderEvent(room, row.event, {
      userId: viewer,
      deviceId: null,
    });
    if (event !== null) chunk.push(event);
  }
  const out: {
    chunk: Record<string, unknown>[];
    next_batch?: string;
    recursion_depth?: number;
  } = { chunk };
  if (query.recurse !== null) {
    out.recursion_depth = query.recurse === 'true' ? 3 : 0;
  }
  if (window.length > slice.length && slice.length > 0) {
    out.next_batch = tokenFor(room, slice.at(-1)!.event);
  }
  return out;
}

export async function threads(
  roomId: string,
  viewer: string,
  include: 'all' | 'participated',
  page: { from: string | null; limit: number },
) {
  const room = await requireRoom(roomId);
  const rendered: { event: string; ev: Record<string, unknown> }[] = [];
  for (const root of await threadRootsOf(theApp().server, roomId)) {
    const ev = await renderEvent(room, root.eventId, {
      userId: viewer,
      deviceId: null,
    });
    if (ev === null) continue;
    const summary = ((ev.unsigned as Record<string, unknown>)['m.relations'] as
      | Record<string, Record<string, unknown>>
      | undefined)?.['m.thread'];
    if (
      summary === undefined ||
      (include === 'participated' && summary.current_user_participated !== true)
    ) continue;
    const latest = summary.latest_event as Record<string, unknown>;
    rendered.push({ event: String(latest.event_id), ev });
  }
  const window = await windowOf(room, rendered, 'b', page.from, null);
  const slice = window.slice(0, page.limit);
  const out: { chunk: Record<string, unknown>[]; next_batch?: string } = {
    chunk: slice.map((r) => r.ev),
  };
  if (window.length > slice.length && slice.length > 0) {
    out.next_batch = tokenFor(room, slice.at(-1)!.event);
  }
  return out;
}
