// The event side of a sync token is one durable server-file stream. Room
// publications and OOB invitation transitions allocate inside the same tx
// as their writes. A rollback rolls back the cursor too; replay allocates
// nothing. This queue serializes the two writers without retaining a Db.
import type { Conn, Db } from '#engine/store/db.ts';

const writers = new Map<string, Promise<void>>();

export async function eventStreamTx<T>(
  db: Db,
  fn: (tx: Conn) => Promise<T>,
): Promise<T> {
  const previous = writers.get(db.path) ?? Promise.resolve();
  const run = previous.then(() => db.tx(fn));
  const settled = run.then(() => undefined, () => undefined);
  writers.set(db.path, settled);
  try {
    return await run;
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
