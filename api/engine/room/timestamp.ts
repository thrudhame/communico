import { MatrixError } from '#engine/matrix-error.ts';
import type { RoomTx } from './index.ts';
import { causalOrder } from './order.ts';

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
