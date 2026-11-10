import { MatrixError } from '#engine/matrix-error.ts';
import type { RoomTx } from './index.ts';
import { precedes } from './causal.ts';

export type TimestampQuery = { ts: number; dir: 'f' | 'b' };
export type TimestampHit = { event_id: string; origin_server_ts: number };

export function parseTimestampQuery(query: URLSearchParams): TimestampQuery {
  const ts = query.get('ts'), dir = query.get('dir');
  if (
    ts === null || !/^-?\d+$/.test(ts) || !Number.isSafeInteger(Number(ts)) ||
    (dir !== 'f' && dir !== 'b')
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'required safe integer ts and dir=f|b',
    );
  }
  return { ts: Number(ts), dir };
}

function exhausted(): never {
  throw new MatrixError(
    503,
    'M_UNKNOWN',
    'timestamp search exceeds bounded history read',
  );
}

// Order equal-time candidates through their actual prev DAG, including paths
// through other timestamps. Untrusted depths never participate. First-owner
// positions and then ids break concurrent-branch ties; old positions never move.
async function causalOrder(tx: RoomTx, ids: string[]): Promise<string[]> {
  if (ids.length < 2) return ids;
  const graph = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const rank = new Map<string, [number, number, string]>();
  const budget = { remaining: 100_000 };
  for (const id of ids) {
    graph.set(id, []);
    const pos = await tx.segments.positionOf(id);
    rank.set(id, [
      pos?.segment ?? Number.MAX_SAFE_INTEGER,
      pos?.offset ?? 0,
      id,
    ]);
  }
  for (const parent of ids) {
    for (const child of ids) {
      if (parent === child) continue;
      const related = await precedes(tx.events, parent, child, budget);
      if (related === null) exhausted();
      if (!related) continue;
      graph.get(child)!.push(parent);
      const next = children.get(parent) ?? [];
      next.push(child);
      children.set(parent, next);
    }
  }
  const compare = (a: string, b: string) => {
    const x = rank.get(a)!, y = rank.get(b)!;
    return x[0] - y[0] || x[1] - y[1] ||
      (x[2] < y[2] ? -1 : x[2] === y[2] ? 0 : 1);
  };
  const ready = ids.filter((id) => graph.get(id)!.length === 0);
  const result: string[] = [];
  let visited = 0;
  while (ready.length > 0) {
    ready.sort(compare);
    const id = ready.shift()!;
    visited++;
    result.push(id);
    for (const child of children.get(id) ?? []) {
      const parents = graph.get(child)!;
      parents.splice(parents.indexOf(id), 1);
      if (parents.length === 0) ready.push(child);
    }
  }
  if (visited !== ids.length) exhausted();
  return result;
}

export async function findTimestamp(
  tx: RoomTx,
  query: TimestampQuery,
  visible: (id: string) => Promise<boolean>,
): Promise<TimestampHit | null> {
  let ts = query.ts, inclusive = true, scanned = 0;
  for (;;) {
    const bucket = await tx.events.timestampBucket(ts, query.dir, inclusive);
    if (bucket.length === 0) return null;
    scanned += bucket.length;
    if (bucket.length > 10_000 || scanned > 100_000) exhausted();
    const eligible: string[] = [];
    for (const row of bucket) if (await visible(row.id)) eligible.push(row.id);
    if (eligible.length > 0) {
      const ordered = await causalOrder(tx, eligible);
      return {
        event_id: query.dir === 'f' ? ordered[0] : ordered[ordered.length - 1],
        origin_server_ts: bucket[0].ts,
      };
    }
    ts = bucket[0].ts;
    inclusive = false;
  }
}
