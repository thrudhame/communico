// Room-owned durable acceptance identities. Only committed targets may leave a
// room attempt; numeric positions never identify a different room incarnation.
import type { Conn } from '#engine/store/db.ts';
import { changePosOf, head } from './changes.ts';

export type CompletionCut = Readonly<{
  roomId: string;
  generation: string;
  through: number;
}>;
export type CompletionTarget = CompletionCut & Readonly<{ eventId: string }>;

export type CompletionState = {
  generation: string;
  legacyThrough: number;
  completedThrough: number;
};

export const COMPLETION_SQL = `
CREATE TABLE completion_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation TEXT NOT NULL,
  legacy_through INTEGER NOT NULL,
  completed_through INTEGER NOT NULL
);
CREATE TABLE completion_receipts(
  event TEXT PRIMARY KEY NOT NULL REFERENCES events(id),
  through INTEGER NOT NULL,
  basis TEXT NOT NULL
);
CREATE INDEX completion_receipts_through ON completion_receipts(through,event);
`;

export async function initializeCompletion(conn: Conn): Promise<void> {
  await conn.exec(COMPLETION_SQL);
  // Both fresh apply and upgrade use this one transaction-owned initializer.
  // A retried UUID is private until the schema transaction actually commits.
  await conn.execute('INSERT INTO completion_state VALUES(1,?,?,0)', [
    crypto.randomUUID(),
    await head(conn),
  ]);
}

export async function completionState(conn: Conn): Promise<CompletionState> {
  const rows = await conn.query('SELECT * FROM completion_state');
  const row = rows[0];
  if (
    rows.length !== 1 || row.singleton !== 1 ||
    typeof row.generation !== 'string' || row.generation.length === 0
  ) {
    throw new Error('E_COMPLETION_IDENTITY');
  }
  return {
    generation: row.generation,
    legacyThrough: Number(row.legacy_through),
    completedThrough: Number(row.completed_through),
  };
}

export async function completionReceipt(
  conn: Conn,
  roomId: string,
  eventId: string,
): Promise<CompletionTarget | null> {
  const [row] = await conn.query(
    'SELECT through FROM completion_receipts WHERE event=?',
    [eventId],
  );
  if (row === undefined) return null;
  const state = await completionState(conn);
  return {
    roomId,
    eventId,
    generation: state.generation,
    through: Number(row.through),
  };
}

export async function recordCompletion(
  conn: Conn,
  roomId: string,
  eventId: string,
): Promise<CompletionTarget> {
  const existing = await completionReceipt(conn, roomId, eventId);
  if (existing !== null) return existing;
  const through = await head(conn);
  await conn.execute("INSERT INTO completion_receipts VALUES(?,?,'accepted')", [
    eventId,
    through,
  ]);
  return (await completionReceipt(conn, roomId, eventId))!;
}

// Explicit upgrade witness, not an estimate of an old event's acceptance head.
// The caller has verified the held event/status against its prepared identity.
export async function reconcileLegacyCompletion(
  conn: Conn,
  roomId: string,
  eventId: string,
): Promise<CompletionTarget> {
  const existing = await completionReceipt(conn, roomId, eventId);
  if (existing !== null) return existing;
  const state = await completionState(conn);
  // Grounding belongs to event/transition records. A later dependency arrival
  // can append an effect keyed by this event without reauthoring/regrounding it.
  const groundedAt = await changePosOf(conn, eventId);
  if (groundedAt === null || groundedAt > state.legacyThrough) {
    throw new Error('E_COMPLETION_LEGACY_CUT: ' + eventId);
  }
  await conn.execute(
    "INSERT INTO completion_receipts VALUES(?,?,'legacy-reconciled')",
    [eventId, state.legacyThrough],
  );
  return (await completionReceipt(conn, roomId, eventId))!;
}

export async function validateCompletion(
  conn: Conn,
  target: CompletionTarget,
): Promise<void> {
  await validateCompletionCut(conn, target);
  const receipt = await completionReceipt(conn, target.roomId, target.eventId);
  if (
    receipt === null || receipt.generation !== target.generation ||
    receipt.through !== target.through || target.through > await head(conn)
  ) {
    throw new Error(
      'E_COMPLETION_TARGET: ' + target.roomId + '/' + target.eventId,
    );
  }
}

export async function captureCompletionCut(
  conn: Conn,
  roomId: string,
): Promise<CompletionCut> {
  const state = await completionState(conn);
  return { roomId, generation: state.generation, through: await head(conn) };
}

export async function validateCompletionCut(
  conn: Conn,
  cut: CompletionCut,
): Promise<void> {
  const state = await completionState(conn);
  if (
    cut.generation !== state.generation || !Number.isSafeInteger(cut.through) ||
    cut.through < 0 || cut.through > await head(conn)
  ) throw new Error('E_COMPLETION_TARGET: ' + cut.roomId);
}

export async function markCompleted(
  conn: Conn,
  generation: string,
  through: number,
): Promise<void> {
  const state = await completionState(conn);
  if (
    state.generation !== generation || !Number.isSafeInteger(through) ||
    through < 0 || through > await head(conn)
  ) throw new Error('E_COMPLETION_PROGRESS');
  if (through > state.completedThrough) {
    await conn.execute(
      'UPDATE completion_state SET completed_through=? WHERE singleton=1',
      [through],
    );
  }
}
