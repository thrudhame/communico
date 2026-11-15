// api/engine/room/extremities.ts — R9: the forward extremity set per stay;
// archived stays keep theirs. Updated in the same room transaction as the
// event that moves the frontier.
import type { Conn } from '#engine/store/db.ts';

export async function frontier(conn: Conn, stay: number): Promise<string[]> {
  const rows = await conn.query(
    'SELECT event FROM extremities WHERE stay = ? ORDER BY event',
    [stay],
  );
  return rows.map((row) => String(row.event));
}

// One authored event need not reference the entire retained frontier. Follow
// Synapse's get_prev_events_for_room: choose ten deepest heads and leave the
// others for later events. Keep the full frontier for state/publication work.
export async function parents(conn: Conn, stay: number): Promise<string[]> {
  const rows = await conn.query(
    `SELECT x.event FROM extremities x JOIN events e ON e.id=x.event
     WHERE x.stay=? ORDER BY e.depth DESC,x.event ASC LIMIT 10`,
    [stay],
  );
  return rows.map((row) => String(row.event)).sort();
}

export async function addExtremity(
  conn: Conn,
  stay: number,
  event: string,
): Promise<void> {
  await conn.execute('INSERT INTO extremities(stay, event) VALUES(?,?)', [
    stay,
    event,
  ]);
}

// A reopened stay inherits the complete retained DAG, independently of the
// bounded parent array chosen for its first authored event.
export async function inherit(
  conn: Conn,
  previous: number,
  stay: number,
): Promise<void> {
  await conn.execute(
    'INSERT INTO extremities(stay,event) SELECT ?,event FROM extremities WHERE stay=?',
    [stay, previous],
  );
}

export async function removeExtremities(
  conn: Conn,
  stay: number,
  events: readonly string[],
): Promise<void> {
  for (let index = 0; index < events.length; index += 500) {
    const chunk = events.slice(index, index + 500);
    const marks = chunk.map(() => '?').join(',');
    await conn.execute(
      `DELETE FROM extremities WHERE stay = ? AND event IN (${marks})`,
      [stay, ...chunk],
    );
  }
}
