// One retained result for a cross-room upgrade. Room initialization and normal
// domain owners perform effects; this journal is not a worker or a scheduler.
import type { Database } from '#engine/store/db.ts';
import type { PreparedRoom } from '#engine/room/create.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export type UpgradePlan = {
  prepared: PreparedRoom | null;
  oldPower: Record<string, unknown>;
  canonical: Record<string, unknown> | null;
};
export type RoomUpgrade = {
  oldRoom: string;
  user: string;
  replacement: string;
  plan: UpgradePlan;
  phase: number;
};

export async function roomUpgrade(
  db: Database,
  oldRoom: string,
): Promise<RoomUpgrade | null> {
  const [row] = await db.query(
    'SELECT * FROM room_upgrades WHERE old_room_id=?',
    [oldRoom],
  );
  return row
    ? {
      oldRoom,
      user: String(row.user_id),
      replacement: String(row.replacement_room),
      plan: JSON.parse(String(row.plan_json)),
      phase: Number(row.phase),
    }
    : null;
}

export async function retainRoomUpgrade(
  db: Database,
  value: RoomUpgrade,
): Promise<RoomUpgrade> {
  await db.execute(
    'INSERT INTO room_upgrades(old_room_id,user_id,replacement_room,plan_json,phase) VALUES(?,?,?,?,0) ON CONFLICT(old_room_id) DO NOTHING',
    [value.oldRoom, value.user, value.replacement, JSON.stringify(value.plan)],
  );
  const retained = (await roomUpgrade(db, value.oldRoom))!;
  if (retained.user !== value.user) {
    throw new MatrixError(
      400,
      'M_BAD_STATE',
      'An upgrade for this room is already retained',
    );
  }
  return retained;
}

export async function advanceRoomUpgrade(
  db: Database,
  value: RoomUpgrade,
  phase: number,
): Promise<void> {
  await db.execute(
    'UPDATE room_upgrades SET phase=MAX(phase,?) WHERE old_room_id=? AND replacement_room=?',
    [phase, value.oldRoom, value.replacement],
  );
  value.phase = Math.max(value.phase, phase);
}

// Like Synapse's response cache, concurrent requests share one admitted attempt.
// The durable row, not this flight, supplies retry identity after settlement or
// process restart. No timer, retry loop or independent work outlives the request.
const active = new WeakMap<
  Database,
  Map<string, Promise<{ replacement_room: string }>>
>();
export async function withRoomUpgrade(
  db: Database,
  oldRoom: string,
  user: string,
  run: () => Promise<{ replacement_room: string }>,
) {
  let flights = active.get(db);
  if (!flights) active.set(db, flights = new Map());
  const key = JSON.stringify([oldRoom, user]);
  let flight = flights.get(key);
  if (!flight) {
    flight = Promise.resolve().then(run);
    flights.set(key, flight);
  }
  try {
    return { ...await flight };
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}
