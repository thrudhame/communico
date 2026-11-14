// api/engine/room/waits.ts — R10: durable waits for missing prevs and
// delayed redaction targets. Kind and state are caller words; expires is
// NULL for the never-expiring (unverifiable) records.
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';

export type Wait = {
  missing: string;
  waiting: string;
  kind: string;
  since: number;
  expires: number | null;
  state: string;
};

function waitOf(row: Row): Wait {
  return {
    missing: String(row.missing),
    waiting: String(row.waiting),
    kind: String(row.kind),
    since: Number(row.since),
    expires: row.expires === null ? null : Number(row.expires),
    state: String(row.state),
  };
}

export async function addWait(conn: Conn, wait: Wait): Promise<void> {
  await conn.execute(
    `INSERT INTO waits(missing, waiting, kind, since, expires, state) VALUES(?,?,?,?,?,?)
     ON CONFLICT(missing, waiting, kind) DO UPDATE SET since = excluded.since,
       expires = excluded.expires, state = excluded.state`,
    [
      wait.missing,
      wait.waiting,
      wait.kind,
      wait.since,
      wait.expires,
      wait.state,
    ],
  );
  await readyFor(conn, wait.missing);
}

// Eligibility belongs to the durable dependency owner. The arrival and its
// ready edges commit together, including arrivals stored only as evidence.
// Prev recovery needs grounding; a redaction needs only the target's bytes.
export async function readyFor(conn: Conn, missing: string): Promise<void> {
  await conn.execute(
    `UPDATE waits SET state='ready' WHERE missing=? AND state!='ready' AND (
      (kind='redaction' AND EXISTS(SELECT 1 FROM events WHERE id=?)) OR
      (kind='prev' AND EXISTS(SELECT 1 FROM event_status WHERE event=? AND grounding='grounded'))
    )`,
    [missing, missing, missing],
  );
}

export async function readyWaits(conn: Conn): Promise<Wait[]> {
  return (await conn.query(
    "SELECT * FROM waits WHERE state='ready' ORDER BY since, waiting, missing, kind",
  )).map(waitOf);
}

export async function deferWait(conn: Conn, wait: Wait): Promise<void> {
  await conn.execute(
    "UPDATE waits SET state='pending' WHERE missing=? AND waiting=? AND kind=?",
    [wait.missing, wait.waiting, wait.kind],
  );
}

export async function waitsFor(conn: Conn, missing: string): Promise<Wait[]> {
  const rows = await conn.query(
    'SELECT * FROM waits WHERE missing = ? ORDER BY waiting, kind',
    [missing],
  );
  return rows.map(waitOf);
}

export async function waitsOf(conn: Conn, waiting: string): Promise<Wait[]> {
  const rows = await conn.query(
    'SELECT * FROM waits WHERE waiting = ? ORDER BY missing, kind',
    [waiting],
  );
  return rows.map(waitOf);
}

// Inventory only; foreground recovery uses the indexed ready queue.
export async function allWaits(conn: Conn): Promise<Wait[]> {
  const rows = await conn.query(
    'SELECT * FROM waits ORDER BY since, waiting, missing, kind',
  );
  return rows.map(waitOf);
}

export async function expiredWaits(conn: Conn, now: number): Promise<Wait[]> {
  const rows = await conn.query(
    'SELECT * FROM waits WHERE expires IS NOT NULL AND expires <= ? ORDER BY expires, missing, waiting',
    [now],
  );
  return rows.map(waitOf);
}

export async function removeWait(
  conn: Conn,
  missing: string,
  waiting: string,
  kind: string,
): Promise<void> {
  await conn.execute(
    'DELETE FROM waits WHERE missing = ? AND waiting = ? AND kind = ?',
    [missing, waiting, kind],
  );
}

export async function removeWaitsOf(
  conn: Conn,
  waiting: string,
): Promise<void> {
  await conn.execute('DELETE FROM waits WHERE waiting = ?', [waiting]);
}
