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

type Repair = { event: string; before: number; height: number };

// Old heights already topologically order all held nodes. Settle a node only
// after its affected held parents, combining their proposed increases first.
// A FIFO instead revisits converging descendants at each intermediate height.
class Repairs {
  private heap: Repair[] = [];

  private before(a: Repair, b: Repair): boolean {
    return a.before < b.before ||
      (a.before === b.before && a.event < b.event);
  }

  add(repair: Repair): void {
    let i = this.heap.length;
    this.heap.push(repair);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!this.before(repair, this.heap[parent])) break;
      this.heap[i] = this.heap[parent];
      i = parent;
    }
    this.heap[i] = repair;
  }

  take(): Repair | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length === 0) return first;
    let i = 0;
    while (i * 2 + 1 < this.heap.length) {
      let child = i * 2 + 1;
      if (
        child + 1 < this.heap.length &&
        this.before(this.heap[child + 1], this.heap[child])
      ) child++;
      if (!this.before(this.heap[child], last!)) break;
      this.heap[i] = this.heap[child];
      i = child;
    }
    this.heap[i] = last!;
    return first;
  }
}

/** Insert the new key and settle each genuinely affected descendant once.
 * Native work follows changed nodes/edges, not every path through their DAG.
 * A normal parent-first insert touches no old room prefix. */
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
  const queue = new Repairs();
  const pending = new Map<string, Repair>();
  const children = async (parent: string, rank: number) => {
    for (
      const row of await conn.query(
        'SELECT t.event,t.height FROM prev_edges p JOIN event_topology t ON t.event=p.event WHERE p.prev=? AND t.height<=?',
        [parent, rank],
      )
    ) {
      const child = String(row.event);
      if (child === event) throw new Error('stored prev DAG has a cycle');
      const known = pending.get(child);
      if (known !== undefined) {
        known.height = Math.max(known.height, rank + 1);
      } else {
        const repair = {
          event: child,
          before: Number(row.height),
          height: rank + 1,
        };
        pending.set(child, repair);
        queue.add(repair);
      }
    }
  };
  await children(event, height);
  for (let repair = queue.take(); repair !== undefined; repair = queue.take()) {
    pending.delete(repair.event);
    await conn.execute('UPDATE event_topology SET height=? WHERE event=?', [
      repair.height,
      repair.event,
    ]);
    await children(repair.event, repair.height);
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
