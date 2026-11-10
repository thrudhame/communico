// api/engine/room/segments.ts — R8: stays and history segments with stable
// ids (allocated from meta.next_segment), and their event positions with
// first-owner uniqueness. History prepends allocate offsets below the
// existing minimum, so old cursors never renumber. A stay has one of
// status open/closed; a history segment open/complete. The current
// published group pointer on a stay belongs to materialize.ts (R7).
// Also the read WALK over the book: one step primitive in both
// directions — backward crosses stay → its history → the previous stay;
// forward crosses a stay's tip into the NEXT stay's history and the
// next stay (G7 — the old forward step ended at the stay tip). A
// backward step past the oldest held event reports the FRONTIER (the
// ungrounded prevs the next backfill asks for).
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import {
  childrenOf,
  getEvent,
  getStatus,
  prevsOf,
} from '#engine/room/events.ts';
import { eventStateAfter } from '#engine/room/state.ts';

export type Segment = {
  id: number;
  kind: 'stay' | 'history' | 'anchor';
  prev: number | null;
  opened_by: string | null;
  opening_group: number | null;
  current_group: number | null;
  status: string;
};

function segmentOf(row: Row): Segment {
  return {
    id: Number(row.id),
    kind: String(row.kind) as Segment['kind'],
    prev: row.prev === null ? null : Number(row.prev),
    opened_by: row.opened_by === null ? null : String(row.opened_by),
    opening_group: row.opening_group === null
      ? null
      : Number(row.opening_group),
    current_group: row.current_group === null
      ? null
      : Number(row.current_group),
    status: String(row.status),
  };
}

async function allocate(conn: Conn): Promise<number> {
  const rows = await conn.query(`SELECT v FROM meta WHERE k = 'next_segment'`);
  if (rows.length === 0) {
    await conn.execute(`INSERT INTO meta(k, v) VALUES('next_segment', '2')`);
    return 1;
  }
  const next = Number(rows[0].v);
  await conn.execute(`UPDATE meta SET v = ? WHERE k = 'next_segment'`, [
    String(next + 1),
  ]);
  return next;
}

export async function createSegment(
  conn: Conn,
  options: {
    kind: 'stay' | 'history' | 'anchor';
    prev?: number | null;
    opened_by?: string | null;
    opening_group?: number | null;
    status?: string;
  },
): Promise<number> {
  const status = options.status ?? 'open';
  if (options.kind === 'stay' && status === 'open') {
    const live = await conn.query(
      `SELECT id FROM segments WHERE kind = 'stay' AND status = 'open'`,
    );
    if (live.length > 0) {
      throw new Error(`room already has an open stay: ${Number(live[0].id)}`);
    }
  }
  const id = await allocate(conn);
  await conn.execute(
    `INSERT INTO segments(id, kind, prev, opened_by, opening_group, current_group, status)
     VALUES(?,?,?,?,?,NULL,?)`,
    [
      id,
      options.kind,
      options.prev ?? null,
      options.opened_by ?? null,
      options.opening_group ?? null,
      status,
    ],
  );
  return id;
}

// Close a segment to its terminal status: closed for a stay, complete for
// a history segment.
export async function closeSegment(conn: Conn, id: number): Promise<void> {
  const rows = await conn.query('SELECT kind FROM segments WHERE id = ?', [
    id,
  ]);
  if (rows.length === 0) throw new Error(`unknown segment ${id}`);
  const terminal = String(rows[0].kind) === 'stay' ? 'closed' : 'complete';
  await conn.execute('UPDATE segments SET status = ? WHERE id = ?', [
    terminal,
    id,
  ]);
}

// Name the event a stay was opened by (a remote join): set once, right
// after the opening event's ingest — the stay is created first so the
// ingest has somewhere to land, then it names its opener.
export async function setOpenedBy(
  conn: Conn,
  id: number,
  event: string,
): Promise<void> {
  const updated = await conn.execute(
    'UPDATE segments SET opened_by = ? WHERE id = ? AND opened_by IS NULL',
    [event, id],
  );
  if (updated === 0) {
    throw new Error(`segment ${id} already has an opened_by event`);
  }
}

export async function getSegment(
  conn: Conn,
  id: number,
): Promise<Segment | null> {
  const rows = await conn.query('SELECT * FROM segments WHERE id = ?', [id]);
  return rows.length === 0 ? null : segmentOf(rows[0]);
}

export async function listSegments(conn: Conn): Promise<Segment[]> {
  const rows = await conn.query('SELECT * FROM segments ORDER BY id');
  return rows.map(segmentOf);
}

export async function openStay(conn: Conn): Promise<Segment | null> {
  const rows = await conn.query(
    `SELECT * FROM segments WHERE kind = 'stay' AND status = 'open'`,
  );
  return rows.length === 0 ? null : segmentOf(rows[0]);
}

// The history segment belonging to a stay (created by the first backfill
// that stay discovers; a stay has at most one).
export async function historyOf(
  conn: Conn,
  stay: number,
): Promise<Segment | null> {
  const rows = await conn.query(
    `SELECT * FROM segments WHERE kind = 'history' AND prev = ?`,
    [stay],
  );
  return rows.length === 0 ? null : segmentOf(rows[0]);
}

// The latest stay of the room — the open one, else the newest closed one
// (an archived room reads through its last stay).
export async function latestStay(conn: Conn): Promise<Segment | null> {
  const rows = await conn.query(
    `SELECT * FROM segments WHERE kind = 'stay' ORDER BY id DESC LIMIT 1`,
  );
  return rows.length === 0 ? null : segmentOf(rows[0]);
}

// The stay opened AFTER the given one (a re-join names the old stay in
// its prev), if any.
export async function nextStayOf(
  conn: Conn,
  stay: number,
): Promise<Segment | null> {
  const rows = await conn.query(
    `SELECT * FROM segments WHERE kind = 'stay' AND prev = ?`,
    [stay],
  );
  return rows.length === 0 ? null : segmentOf(rows[0]);
}

export async function positionOf(
  conn: Conn,
  event: string,
): Promise<{ segment: number; offset: number } | null> {
  const rows = await conn.query(
    'SELECT segment, offset FROM positions WHERE event = ?',
    [event],
  );
  if (rows.length === 0) return null;
  return {
    segment: Number(rows[0].segment),
    offset: Number(rows[0].offset),
  };
}

export async function appendPosition(
  conn: Conn,
  segment: number,
  event: string,
): Promise<number> {
  const existing = await positionOf(conn, event);
  if (existing !== null) {
    throw new Error(`event already positioned in segment ${existing.segment}`);
  }
  const rows = await conn.query(
    'SELECT MAX(offset) AS top FROM positions WHERE segment = ?',
    [segment],
  );
  const offset = rows[0].top === null ? 0 : Number(rows[0].top) + 1;
  await conn.execute(
    'INSERT INTO positions(segment, offset, event) VALUES(?,?,?)',
    [segment, offset, event],
  );
  return offset;
}

// History prepends: `events` are oldest-first and land below every
// existing offset, so old cursors never renumber.
export async function prependPositions(
  conn: Conn,
  segment: number,
  events: readonly string[],
): Promise<number[]> {
  const rows = await conn.query(
    'SELECT MIN(offset) AS bottom FROM positions WHERE segment = ?',
    [segment],
  );
  const bottom = rows[0].bottom === null ? 0 : Number(rows[0].bottom);
  const offsets: number[] = [];
  for (let index = 0; index < events.length; index++) {
    const existing = await positionOf(conn, events[index]);
    if (existing !== null) {
      throw new Error(
        `event already positioned in segment ${existing.segment}`,
      );
    }
    const offset = bottom - events.length + index;
    await conn.execute(
      'INSERT INTO positions(segment, offset, event) VALUES(?,?,?)',
      [segment, offset, events[index]],
    );
    offsets.push(offset);
  }
  return offsets;
}

// A page of a segment's positions, inclusive of `from` in both directions.
export async function positionsPage(
  conn: Conn,
  segment: number,
  from: number,
  dir: 'f' | 'b',
  limit: number,
): Promise<{ offset: number; event: string }[]> {
  const rows = dir === 'f'
    ? await conn.query(
      'SELECT offset, event FROM positions WHERE segment = ? AND offset >= ? ORDER BY offset ASC LIMIT ?',
      [segment, from, limit],
    )
    : await conn.query(
      'SELECT offset, event FROM positions WHERE segment = ? AND offset <= ? ORDER BY offset DESC LIMIT ?',
      [segment, from, limit],
    );
  return rows.map((row) => ({
    offset: Number(row.offset),
    event: String(row.event),
  }));
}

// --- the walk (G7) -----------------------------------------------------------

export type WalkCursor = { segment: number; offset: number };

export type WalkStep =
  | { kind: 'event'; event: string; cursor: WalkCursor }
  // the gap-facing ungrounded prevs: what the next backfill asks for
  | { kind: 'frontier'; cursor: WalkCursor; prevs: string[] }
  // An isolated anchor has no proven forward adjacency. Keep a resumable
  // cursor instead of claiming the gap complete or jumping to its owning stay.
  | { kind: 'gap'; cursor: WalkCursor }
  | { kind: 'end' };

async function offsetBound(
  conn: Conn,
  segment: number,
  dir: 'min' | 'max',
): Promise<number | null> {
  const rows = await conn.query(
    `SELECT ${
      dir === 'min' ? 'MIN' : 'MAX'
    }(offset) AS bound FROM positions WHERE segment = ?`,
    [segment],
  );
  return rows[0].bound === null ? null : Number(rows[0].bound);
}

async function eventAtOffset(
  conn: Conn,
  segment: number,
  offset: number,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT event FROM positions WHERE segment = ? AND offset = ?',
    [segment, offset],
  );
  return rows.length === 0 ? null : String(rows[0].event);
}

// The cited prevs that do not ground: unknown, or held without a genuine
// after-state (evidence/pending carry bytes, not state-at — G2).
async function ungroundedPrevsOf(conn: Conn, event: string): Promise<string[]> {
  const missing: string[] = [];
  for (const prev of await prevsOf(conn, event)) {
    const row = await getEvent(conn, prev);
    const after = row === null ? null : await eventStateAfter(conn, prev);
    if (row === null || after === null) missing.push(prev);
  }
  return missing;
}

// The walk's start for a backward read: just past the latest stay's tip.
export async function walkStart(conn: Conn): Promise<WalkCursor | null> {
  const stay = await latestStay(conn);
  if (stay === null) return null;
  const top = await offsetBound(conn, stay.id, 'max');
  return { segment: stay.id, offset: (top ?? -1) + 1 };
}

// One step through the book. Backward: the stay's positions descending,
// then its history segment's (newest→oldest), then the previous stay's.
// Forward: the mirror — a stay's tip continues into the NEXT stay's
// history and the next stay (G7). A backward step past the oldest held
// event of an open history segment (or of a stay with no fetched
// history) reports the frontier; a complete one crosses into the
// previous stay; past everything is the end.
export async function stepPosition(
  conn: Conn,
  cursor: WalkCursor,
  dir: 'f' | 'b',
): Promise<WalkStep> {
  let at = cursor;
  for (;;) {
    if (dir === 'b') {
      const rows = await conn.query(
        'SELECT offset, event FROM positions WHERE segment = ? AND offset < ? ORDER BY offset DESC LIMIT 1',
        [at.segment, at.offset],
      );
      if (rows.length > 0) {
        return {
          kind: 'event',
          event: String(rows[0].event),
          cursor: { segment: at.segment, offset: Number(rows[0].offset) },
        };
      }
      const seg = await getSegment(conn, at.segment);
      if (seg === null) return { kind: 'end' };
      if (seg.kind === 'stay') {
        const history = await historyOf(conn, seg.id);
        const historyTop = history === null
          ? null
          : await offsetBound(conn, history.id, 'max');
        if (history !== null && historyTop !== null) {
          at = { segment: history.id, offset: historyTop + 1 };
          continue;
        }
        // no fetched history: the stay's first event faces the gap
        const first = await offsetBound(conn, seg.id, 'min');
        if (first !== null) {
          const facing = await eventAtOffset(conn, seg.id, first);
          const prevs = facing === null
            ? []
            : await ungroundedPrevsOf(conn, facing);
          if (prevs.length > 0) {
            return {
              kind: 'frontier',
              cursor: { segment: seg.id, offset: first },
              prevs,
            };
          }
        }
        if (seg.prev !== null) {
          const prevTop = await offsetBound(conn, seg.prev, 'max');
          at = { segment: seg.prev, offset: (prevTop ?? -1) + 1 };
          continue;
        }
        return { kind: 'end' };
      }
      // a history segment: past its oldest event
      const status = seg.status;
      const oldest = await offsetBound(conn, seg.id, 'min');
      if (status !== 'complete' && oldest !== null) {
        const facing = await eventAtOffset(conn, seg.id, oldest);
        const prevs = facing === null
          ? []
          : await ungroundedPrevsOf(conn, facing);
        if (prevs.length > 0) {
          return {
            kind: 'frontier',
            cursor: { segment: seg.id, offset: oldest },
            prevs,
          };
        }
      }
      if (seg.kind === 'anchor') {
        const facing = oldest === null
          ? null
          : await eventAtOffset(conn, seg.id, oldest);
        for (const prev of facing === null ? [] : await prevsOf(conn, facing)) {
          const position = await positionOf(conn, prev);
          if (position !== null && position.segment !== seg.id) {
            at = { ...position, offset: position.offset + 1 };
            break;
          }
        }
        if (at.segment !== seg.id) continue;
        return { kind: 'end' };
      }
      // the stay before the one this history belongs to
      const owner = seg.prev === null ? null : await getSegment(conn, seg.prev);
      const prevStay = owner === null ? null : owner.prev;
      if (prevStay !== null) {
        const prevTop = await offsetBound(conn, prevStay, 'max');
        at = { segment: prevStay, offset: (prevTop ?? -1) + 1 };
        continue;
      }
      return { kind: 'end' };
    }
    // forward
    const rows = await conn.query(
      'SELECT offset, event FROM positions WHERE segment = ? AND offset > ? ORDER BY offset ASC LIMIT 1',
      [at.segment, at.offset],
    );
    if (rows.length > 0) {
      return {
        kind: 'event',
        event: String(rows[0].event),
        cursor: { segment: at.segment, offset: Number(rows[0].offset) },
      };
    }
    const seg = await getSegment(conn, at.segment);
    if (seg === null) return { kind: 'end' };
    if (seg.kind === 'anchor') {
      // An actual positioned child proves the forward connection, even when
      // that child was acquired in another segment. Never infer it from owner
      // stay, depth, timestamp, or segment allocation order.
      const tip = await eventAtOffset(conn, seg.id, at.offset);
      const next: { event: string; cursor: WalkCursor }[] = [];
      for (const child of tip === null ? [] : await childrenOf(conn, tip)) {
        const position = await positionOf(conn, child);
        const status = await getStatus(conn, child);
        if (
          position !== null && status?.standing === 'accepted' &&
          status.grounding === 'grounded' &&
          await eventStateAfter(conn, child) !== null
        ) {
          next.push({ event: child, cursor: position });
        }
      }
      next.sort((a, b) =>
        a.cursor.segment - b.cursor.segment ||
        a.cursor.offset - b.cursor.offset || a.event.localeCompare(b.event)
      );
      if (next.length > 0) return { kind: 'event', ...next[0] };
      return { kind: 'gap', cursor: at };
    }
    if (seg.kind === 'history') {
      // the owning stay's first event comes right after the newest
      // history event
      const owner = seg.prev;
      if (owner === null) return { kind: 'end' };
      const ownerMin = await offsetBound(conn, owner, 'min');
      at = { segment: owner, offset: (ownerMin ?? 0) - 1 };
      continue;
    }
    // a stay's tip: the NEXT stay's history (the gap), then the next
    // stay itself — forward never ends just because the stay did (G7)
    const next = await nextStayOf(conn, seg.id);
    if (next === null) return { kind: 'end' };
    const nextHistory = await historyOf(conn, next.id);
    const nextHistoryMin = nextHistory === null
      ? null
      : await offsetBound(conn, nextHistory.id, 'min');
    if (nextHistory !== null && nextHistoryMin !== null) {
      at = { segment: nextHistory.id, offset: nextHistoryMin - 1 };
      continue;
    }
    const nextMin = await offsetBound(conn, next.id, 'min');
    at = { segment: next.id, offset: (nextMin ?? 0) - 1 };
  }
}

// c<segment>_<offset> — the walk's stable bookmark; offsets are signed
// (history prepends go negative), segment ids are never reused.
export function formatCursor(cursor: WalkCursor): string {
  return `c${cursor.segment}_${cursor.offset}`;
}

export function parseCursor(token: string): WalkCursor | null {
  const m = /^c(\d+)_(-?\d+)$/.exec(token);
  if (m === null) return null;
  return { segment: Number(m[1]), offset: Number(m[2]) };
}
