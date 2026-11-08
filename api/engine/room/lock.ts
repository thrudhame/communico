// api/engine/room/lock.ts — the per-room mutation lock (R13): an
// in-process async mutex keyed by room id, sitting above the store's file
// gate. Network never runs under it; callers revalidate the room's
// lifecycle after acquiring it (G8 — every lifecycle read happens inside
// the locked room transaction).
const locks = new Map<string, Promise<void>>();

// Serialize fn against every other mutation of the same room id. The lock
// is NOT reentrant: a fn that calls withRoomLock for the same room id
// deadlocks.
export async function withRoomLock<T>(
  roomId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = prev.then(() => mine);
  locks.set(roomId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(roomId) === tail) locks.delete(roomId);
  }
}
