// Authenticated client causal obligations. All operations use the owning tenant
// attempt; neither room nor server reads are permitted inside this module.
import type {
  CompletionCut,
  CompletionTarget,
} from '#engine/room/completion.ts';
import type { Conn } from '#engine/store/db.ts';
import type { DeviceIdentity } from './devices.ts';
import { deviceById } from './devices.ts';
import { nextCounter } from './accountdata.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export const CLIENT_COMPLETION_SQL = `
CREATE TABLE transaction_completions(
  localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
  endpoint TEXT NOT NULL, txn_id TEXT NOT NULL, room_id TEXT NOT NULL,
  room_generation TEXT NOT NULL, event_id TEXT NOT NULL, through INTEGER NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
  PRIMARY KEY(localpart,device_id,generation,endpoint,txn_id)
);
CREATE INDEX transaction_completions_room ON transaction_completions(room_id,room_generation,through);
CREATE TABLE client_completion_cuts(
  localpart TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
  room_id TEXT NOT NULL, room_generation TEXT NOT NULL, through INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(localpart,device_id,generation,room_id,room_generation)
);
CREATE INDEX client_completion_cuts_room ON client_completion_cuts(room_id,room_generation,through);
`;

export type PendingCompletion = CompletionCut & Readonly<{ revision: number }>;

function scope(device: DeviceIdentity): [string, string, number] {
  return [device.localpart, device.deviceId, device.generation];
}

async function requireDevice(
  conn: Conn,
  device: DeviceIdentity,
): Promise<void> {
  const held = await deviceById(conn, device.deviceId, device.localpart);
  if (held === null || held.generation !== device.generation) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'device no longer exists');
  }
}

// Called only from submission finish, in the same attempt as completed=1.
export async function finishCompletion(
  conn: Conn,
  device: DeviceIdentity,
  endpoint: string,
  txnId: string,
  target: CompletionTarget,
): Promise<void> {
  await requireDevice(conn, device);
  const key = [...scope(device), endpoint, txnId];
  const [receipt] = await conn.query(
    'SELECT event_id,room_id,completed FROM transactions WHERE localpart=? AND device_id=? AND generation=? AND endpoint=? AND txn_id=?',
    key,
  );
  if (
    receipt?.event_id !== target.eventId || receipt.room_id !== target.roomId ||
    receipt.completed !== 1
  ) throw new Error('E_CLIENT_COMPLETION_RECEIPT');
  const [existing] = await conn.query(
    'SELECT room_id,room_generation,event_id,through FROM transaction_completions WHERE localpart=? AND device_id=? AND generation=? AND endpoint=? AND txn_id=?',
    key,
  );
  if (existing !== undefined) {
    if (
      existing.room_id !== target.roomId ||
      existing.room_generation !== target.generation ||
      existing.event_id !== target.eventId ||
      existing.through !== target.through
    ) throw new Error('E_CLIENT_COMPLETION_TARGET');
  } else {
    await conn.execute(
      'INSERT INTO transaction_completions(localpart,device_id,generation,endpoint,txn_id,room_id,room_generation,event_id,through) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        ...key,
        target.roomId,
        target.generation,
        target.eventId,
        target.through,
      ],
    );
  }
  const pendingKey = [...scope(device), target.roomId, target.generation];
  const [pending] = await conn.query(
    'SELECT through FROM client_completion_cuts WHERE localpart=? AND device_id=? AND generation=? AND room_id=? AND room_generation=?',
    pendingKey,
  );
  if (pending !== undefined && Number(pending.through) >= target.through) {
    return;
  }
  const revision = await nextCounter(conn, 'client_completion');
  await conn.execute(
    `INSERT INTO client_completion_cuts VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(localpart,device_id,generation,room_id,room_generation)
    DO UPDATE SET through=excluded.through,revision=excluded.revision`,
    [...pendingKey, target.through, revision],
  );
}

export async function pendingCompletions(
  conn: Conn,
  device: DeviceIdentity,
): Promise<PendingCompletion[]> {
  await requireDevice(conn, device);
  return (await conn.query(
    'SELECT room_id,room_generation,through,revision FROM client_completion_cuts WHERE localpart=? AND device_id=? AND generation=? ORDER BY room_id,room_generation',
    scope(device),
  )).map((row) => ({
    roomId: String(row.room_id),
    generation: String(row.room_generation),
    through: Number(row.through),
    revision: Number(row.revision),
  }));
}

export async function retireCompletion(
  conn: Conn,
  device: DeviceIdentity,
  captured: PendingCompletion,
): Promise<void> {
  await requireDevice(conn, device);
  await conn.execute(
    'DELETE FROM client_completion_cuts WHERE localpart=? AND device_id=? AND generation=? AND room_id=? AND room_generation=? AND through=? AND revision=?',
    [
      ...scope(device),
      captured.roomId,
      captured.generation,
      captured.through,
      captured.revision,
    ],
  );
}

export async function forgetClientCompletions(
  conn: Conn,
  localpart: string,
  deviceId: string,
): Promise<void> {
  for (const table of ['transaction_completions', 'client_completion_cuts']) {
    await conn.execute(
      `DELETE FROM ${table} WHERE localpart=? AND device_id=?`,
      [localpart, deviceId],
    );
  }
}

// The lifecycle owner calls this only while the original room is still held and
// full completion/publication have been verified. Historical receipts are not
// pending work and remain valid after an intentional room unlink.
export async function reconcileRoomCompletions(
  conn: Conn,
  roomId: string,
  completed: CompletionCut | null,
): Promise<void> {
  const rows = await conn.query(
    'SELECT room_generation,through FROM client_completion_cuts WHERE room_id=?',
    [roomId],
  );
  if (
    rows.some((row) =>
      completed === null ||
      row.room_generation !== completed.generation ||
      Number(row.through) > completed.through
    )
  ) {
    throw new Error('E_CLIENT_COMPLETION_RETIREMENT: ' + roomId);
  }
  const receipts = await conn.query(
    'SELECT room_generation,through FROM transaction_completions WHERE room_id=? AND retired=0',
    [roomId],
  );
  if (
    receipts.some((row) =>
      completed === null || row.room_generation !== completed.generation ||
      Number(row.through) > completed.through
    )
  ) throw new Error('E_CLIENT_COMPLETION_RETIREMENT: ' + roomId);
  // This durable witness is written only while the exact source incarnation and
  // its completed publication are still held. It survives reuse of the room ID.
  await conn.execute(
    'UPDATE transaction_completions SET retired=1 WHERE room_id=? AND retired=0',
    [roomId],
  );
  await conn.execute('DELETE FROM client_completion_cuts WHERE room_id=?', [
    roomId,
  ]);
}
