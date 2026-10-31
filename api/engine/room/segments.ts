// api/engine/room/segments.ts — R8: stays and history segments with stable
// ids (allocated from meta.next_segment), and their event positions with
// first-owner uniqueness. History prepends allocate offsets below the
// existing minimum, so old cursors never renumber. A stay has one of
// status open/closed; a history segment open/complete. The current
// published group pointer on a stay belongs to materialize.ts (R7).
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';

export type Segment = {
  id: number;
  kind: 'stay' | 'history';
  prev: number | null;
  opened_by: string | null;
  opening_group: number | null;
  current_group: number | null;
  status: string;
};

function segmentOf(row: Row): Segment {
  return {
    id: Number(row.id),
    kind: String(row.kind) as 'stay' | 'history',
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
    kind: 'stay' | 'history';
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
