// api/engine/room/changes.ts — R11: the room change log; the server file's
// roll-forward source (its watermark is the last pos). Every room mutation
// the server must project is appended in the same room transaction.
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';

export type Change = {
  pos: number;
  kind: string;
  event: string | null;
  data: string;
};

export async function head(conn: Conn): Promise<number> {
  const rows = await conn.query(
    'SELECT COALESCE(MAX(pos), 0) AS pos FROM changes',
  );
  return Number(rows[0].pos);
}

function changeOf(row: Row): Change {
  return {
    pos: Number(row.pos),
    kind: String(row.kind),
    event: row.event === null ? null : String(row.event),
    data: String(row.data),
  };
}

export async function appendChange(
  conn: Conn,
  kind: string,
  event: string | null,
  data: unknown,
): Promise<number> {
  const rows = await conn.query(
    'INSERT INTO changes(kind, event, data) VALUES(?,?,?) RETURNING pos',
    [kind, event, JSON.stringify(data)],
  );
  return Number(rows[0].pos);
}

export async function changesAfter(
  conn: Conn,
  pos: number,
  limit: number,
): Promise<Change[]> {
  const rows = await conn.query(
    'SELECT pos, kind, event, data FROM changes WHERE pos > ? ORDER BY pos LIMIT ?',
    [pos, limit],
  );
  return rows.map(changeOf);
}

// The change position of an event's live-ingest entry ('event' or
// 'transition' — the kinds a publication can hang off; history entries
// never map to publications).
export async function changePosOf(
  conn: Conn,
  event: string,
): Promise<number | null> {
  const rows = await conn.query(
    `SELECT pos FROM changes WHERE event = ? AND kind IN ('event', 'transition') ORDER BY pos DESC LIMIT 1`,
    [event],
  );
  return rows.length === 0 ? null : Number(rows[0].pos);
}

// Applied redaction effects are room truth even before projection catches up.
// Read the durable effect log, not raw PDUs or the server projection watermark.
export async function redactionOf(
  conn: Conn,
  target: string,
): Promise<string | null> {
  const rows = await conn.query(
    "SELECT event FROM changes WHERE kind = 'redaction' AND json_extract(data, '$.target') = ? ORDER BY pos LIMIT 1",
    [target],
  );
  return rows.length === 0 ? null : String(rows[0].event);
}
