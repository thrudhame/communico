// api/engine/relations.ts — band C item 6 (D7): the relations index read
// side — /relations (three path forms) and /threads. Rendering reuses
// timeline.ts's clientEventForRow (which also bundles thread roots —
// one-way dependency, no cycle). Pagination is the sync-token grammar
// (§3e): from/next_batch carry the s<e> child position, exclusive on
// both directions; dir=b (default) is newest-first (relations.yaml:62).
import { serverDb, withDb } from './db.ts';
import { MatrixError } from './matrix-error.ts';
import { eventIndexRow, lookupRoom, parseStreamToken } from './room.ts';
import { clientEventForRow } from './timeline.ts';

export interface RelationRow {
  eventId: string;
  relType: string | null;
  seq: number;
}

// The children of a parent event, oldest first; relType optional (the
// /relations/{id} vs /relations/{id}/{relType} forms). Event-type
// filtering happens at render time — the index stores no type column
// (plan §2 schema). Unknown room / parent → 404 (relations.yaml:71-72).
export async function relationRows(
  roomId: string,
  eventId: string,
  relType?: string,
): Promise<RelationRow[]> {
  if (!(await lookupRoom(roomId))) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  if ((await eventIndexRow(roomId, eventId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  return await withDb(serverDb(), async (c) => {
    const r = relType === undefined
      ? await c.query(
        'SELECT event_id, rel_type, seq FROM relations WHERE room_id = $1 AND relates_to = $2 ORDER BY seq ASC;',
        [roomId, eventId],
      )
      : await c.query(
        'SELECT event_id, rel_type, seq FROM relations WHERE room_id = $1 AND relates_to = $2 AND rel_type = $3 ORDER BY seq ASC;',
        [roomId, eventId, relType],
      );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      eventId: String(row.event_id),
      relType: row.rel_type == null ? null : String(row.rel_type),
      seq: Number(row.seq),
    }));
  });
}

export interface ThreadRootRow {
  rootEventId: string;
  latestSeq: number;
  count: number;
}

// Thread roots in a room with their latest-child seq and child count,
// latest-first (3f: ORDER BY max(child.seq) DESC per root).
export async function threadRootRows(
  roomId: string,
): Promise<ThreadRootRow[]> {
  if (!(await lookupRoom(roomId))) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT relates_to, MAX(seq) AS latest, COUNT(*) AS n
       FROM relations WHERE room_id = $1 AND rel_type = 'm.thread'
       GROUP BY relates_to ORDER BY latest DESC;`,
      [roomId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      rootEventId: String(row.relates_to),
      latestSeq: Number(row.latest),
      count: Number(row.n),
    }));
  });
}

// GET /relations/{eventId}[/{relType}[/{eventType}]]: the children,
// rendered, paginated by their own seq. Filtered first, then paginated —
// the limit always counts matching events.
export async function relationsOf(
  roomId: string,
  eventId: string,
  filters: { relType?: string; eventType?: string },
  page: { fromSeq: number | null; dir: 'b' | 'f'; limit: number },
): Promise<{ chunk: Record<string, unknown>[]; next_batch?: string }> {
  const rows = await relationRows(roomId, eventId, filters.relType);
  const rendered: { seq: number; ev: Record<string, unknown> }[] = [];
  for (const r of rows) {
    const idx = await eventIndexRow(roomId, r.eventId);
    if (idx === null || idx.rejected || idx.soft_failed) continue;
    const room = (await lookupRoom(roomId))!;
    const ev = await clientEventForRow(room.dbName, room.roomVersion, idx);
    if (ev === null) continue;
    if (filters.eventType !== undefined && ev.type !== filters.eventType) {
      continue;
    }
    rendered.push({ seq: r.seq, ev });
  }
  rendered.sort((a, b) => page.dir === 'b' ? b.seq - a.seq : a.seq - b.seq);
  const window = page.fromSeq === null
    ? rendered
    : rendered.filter((r) =>
      page.dir === 'b' ? r.seq < page.fromSeq! : r.seq > page.fromSeq!
    );
  const limit = Math.max(0, page.limit);
  const chunk = window.slice(0, limit === 0 ? window.length : limit);
  const out: { chunk: Record<string, unknown>[]; next_batch?: string } = {
    chunk: chunk.map((r) => r.ev),
  };
  if (limit > 0 && window.length > limit && chunk.length > 0) {
    out.next_batch = `s${chunk[chunk.length - 1].seq}`;
  }
  return out;
}

// The /relations query-param handling shared by the three path forms
// (dir/limit/from validation in one place; the endpoint files stay
// one-liners so the endpoints tree carries route files only).
export async function relationsPage(
  roomId: string,
  eventId: string,
  filters: { relType?: string; eventType?: string },
  query: { dir: string | null; limit: string | null; from: string | null },
): Promise<{ chunk: Record<string, unknown>[]; next_batch?: string }> {
  const dirRaw = query.dir ?? 'b';
  if (dirRaw !== 'b' && dirRaw !== 'f') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad dir: ' + dirRaw);
  }
  const limit = query.limit !== null
    ? Math.max(0, Number(query.limit) || 0)
    : 10;
  const from = parseStreamToken(query.from);
  return await relationsOf(roomId, eventId, filters, {
    fromSeq: from?.eSeq ?? null,
    dir: dirRaw,
    limit,
  });
}

// GET /threads: the room's thread roots (latest-child seq desc), each
// rendered WITH the bundled m.thread aggregation; include=participated
// keeps only roots the viewer would see current_user_participated on.
export async function threads(
  roomId: string,
  viewer: string,
  include: 'all' | 'participated',
  page: { fromSeq: number | null; limit: number },
): Promise<{ chunk: Record<string, unknown>[]; next_batch?: string }> {
  const roots = await threadRootRows(roomId);
  const window = page.fromSeq === null
    ? roots
    : roots.filter((r) => r.latestSeq < page.fromSeq!);
  const limit = Math.max(0, page.limit);
  const slice = window.slice(0, limit === 0 ? window.length : limit);
  const room = (await lookupRoom(roomId))!;
  const chunk: Record<string, unknown>[] = [];
  for (const root of slice) {
    const idx = await eventIndexRow(roomId, root.rootEventId);
    if (idx === null || idx.rejected || idx.soft_failed) continue;
    const ev = await clientEventForRow(room.dbName, room.roomVersion, idx, {
      userId: viewer,
      deviceId: null,
    });
    if (ev === null) continue;
    if (
      include === 'participated' &&
      ((ev.unsigned as Record<string, unknown>)?.['m.relations'] as
          | Record<string, Record<string, unknown>>
          | undefined)?.['m.thread']?.current_user_participated !== true
    ) {
      continue;
    }
    chunk.push(ev);
  }
  const out: { chunk: Record<string, unknown>[]; next_batch?: string } = {
    chunk,
  };
  if (limit > 0 && window.length > limit && slice.length > 0) {
    out.next_batch = `s${slice[slice.length - 1].latestSeq}`;
  }
  return out;
}
