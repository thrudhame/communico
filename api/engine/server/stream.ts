// The event side of a sync token is one durable server-file stream. Room
// publications and OOB invitation transitions allocate inside the same tx
// as their writes. A rollback rolls back the cursor too; replay allocates
// nothing. This queue serializes the two writers without retaining a Db.
import type { Conn, Database as Db } from '#engine/store/db.ts';

const writers = new Map<string, Promise<void>>();
const listeners = new Set<(path: string) => void>();

export function onEventStream(fn: (path: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function eventStreamTx<T>(
  db: Db,
  fn: (tx: Conn) => Promise<T>,
): Promise<T> {
  const previous = writers.get(db.path) ?? Promise.resolve();
  const run = previous.then(() => db.tx(fn));
  const settled = run.then(() => undefined, () => undefined);
  writers.set(db.path, settled);
  try {
    const result = await run;
    for (const fn of listeners) fn(db.path);
    return result;
  } finally {
    if (writers.get(db.path) === settled) writers.delete(db.path);
  }
}

export async function nextEventSeq(tx: Conn): Promise<number> {
  await tx.execute(
    "INSERT INTO counters(name, value) VALUES('events', 0) ON CONFLICT(name) DO NOTHING",
  );
  await tx.execute(
    "UPDATE counters SET value = value + 1 WHERE name = 'events'",
  );
  const rows = await tx.query(
    "SELECT value FROM counters WHERE name = 'events'",
  );
  return Number(rows[0].value);
}

export async function eventStreamMax(db: Db): Promise<number> {
  const rows = await db.query(
    "SELECT value FROM counters WHERE name = 'events'",
  );
  return rows.length === 0 ? 0 : Number(rows[0].value);
}

/** Durable allocator ceilings, read together before a sync consumer waits. */
export async function syncStreamHeads(db: Db) {
  const counters = new Map(
    (await db.query('SELECT name,value FROM counters')).map((
      row,
    ) => [String(row.name), Number(row.value)]),
  );
  return {
    events: counters.get('events') ?? 0,
    presence: counters.get('presence') ?? 0,
    receipts: counters.get('receipts') ?? 0,
    devices: counters.get('devices') ?? 0,
    notifications: counters.get('notifications') ?? 0,
  };
}
