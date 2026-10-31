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
