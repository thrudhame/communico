// A local derived prev-DAG index, independent of remote PDU depth. Maintained
// with event/edge insertion in the room transaction, including late parents.
// Reads use global keys, so filtering or adding page anchors cannot reorder IDs.
import type { Conn } from '#engine/store/db.ts';

export const TOPOLOGY_SQL = `
CREATE TABLE event_topology(
  event TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  height INTEGER NOT NULL CHECK(height >= 1)
);
`;

export type OrderKey = { height: number; segment: number; offset: number };

/** Seed an upgraded room once, in the store-owned upgrade transaction. Missing
 * parents have height zero; later insertion repairs their held descendants. */
export async function rebuildTopology(conn: Conn): Promise<void> {
  const nodes = new Map(
    (await conn.query('SELECT id FROM events')).map((row) => [
      String(row.id),
      { height: 1, pending: 0, children: [] as string[] },
    ]),
  );
  for (const edge of await conn.query('SELECT event,prev FROM prev_edges')) {
    const parent = nodes.get(String(edge.prev));
    const child = nodes.get(String(edge.event));
    if (parent === undefined || child === undefined) continue;
    parent.children.push(String(edge.event));
    child.pending++;
  }
  const queue = [...nodes].filter(([, row]) => row.pending === 0).map(([id]) =>
    id
  );
  for (let i = 0; i < queue.length; i++) {
    const row = nodes.get(queue[i])!;
    for (const id of row.children) {
      const child = nodes.get(id)!;
      child.height = Math.max(child.height, row.height + 1);
      if (--child.pending === 0) queue.push(id);
    }
  }
  if (queue.length !== nodes.size) {
    throw new Error('stored prev DAG has a cycle');
  }
  for (let i = 0; i < queue.length; i += 200) {
    const batch = queue.slice(i, i + 200);
    await conn.execute(
      'INSERT INTO event_topology(event,height) VALUES ' +
        batch.map(() => '(?,?)').join(','),
      batch.flatMap((id) => [id, nodes.get(id)!.height]),
    );
  }
}

/** Insert the new key and propagate only actual increases through the reverse
 * edge index. A normal parent-first insert touches no old room prefix. */
export async function indexTopology(conn: Conn, event: string): Promise<void> {
  const rows = await conn.query(
    'SELECT coalesce(max(t.height),0)+1 AS height FROM prev_edges p LEFT JOIN event_topology t ON t.event=p.prev WHERE p.event=?',
    [event],
  );
  const height = Number(rows[0].height);
  await conn.execute('INSERT INTO event_topology(event,height) VALUES(?,?)', [
    event,
    height,
  ]);
  const queue: [string, number][] = [[event, height]];
  const latest = new Map(queue);
  for (let i = 0; i < queue.length; i++) {
    const [parent, rank] = queue[i];
    if (latest.get(parent)! > rank) continue;
    for (
      const row of await conn.query(
        'SELECT t.event FROM prev_edges p JOIN event_topology t ON t.event=p.event WHERE p.prev=? AND t.height<=?',
        [parent, rank],
      )
    ) {
      const child = String(row.event);
      if (child === event) throw new Error('stored prev DAG has a cycle');
      await conn.execute('UPDATE event_topology SET height=? WHERE event=?', [
        rank + 1,
        child,
      ]);
      latest.set(child, rank + 1);
      queue.push([child, rank + 1]);
    }
  }
}

/** Indexed keys for precisely the requested IDs; never an ancestry walk. */
export async function orderKeys(
  conn: Conn,
  ids: readonly string[],
): Promise<Map<string, OrderKey>> {
  const keys = new Map<string, OrderKey>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 400) {
    const batch = unique.slice(i, i + 400);
    const rows = await conn.query(
      `SELECT t.event,t.height,p.segment,p.offset FROM event_topology t LEFT JOIN positions p ON p.event=t.event WHERE t.event IN (${
        batch.map(() => '?').join(',')
      })`,
      batch,
    );
    for (const row of rows) {
      keys.set(String(row.event), {
        height: Number(row.height),
        segment: row.segment === null
          ? Number.MAX_SAFE_INTEGER
          : Number(row.segment),
        offset: row.offset === null ? 0 : Number(row.offset),
      });
    }
  }
  return keys;
}
