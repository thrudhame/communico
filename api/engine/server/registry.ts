// api/engine/server/registry.ts — the room registry (plan §2 row 3):
// registration on room creation (after the room file exists — room-first),
// and discovery at startup: the store's rooms/ layout is scanned, each
// file's recorded id read, the missing registered (covers a crash between
// the room create and the registry insert).
import { keyFor } from '#engine/store/layout.ts';
import type { Store } from '#engine/store/index.ts';

// Returns true when the row was inserted (false: already registered).
export async function registerRoom(
  store: Store,
  roomId: string,
): Promise<boolean> {
  const server = await store.server();
  const written = await server.execute(
    `INSERT INTO rooms(room_id, file_key, created_ms) VALUES(?,?,?)
     ON CONFLICT(room_id) DO NOTHING`,
    [roomId, await keyFor(roomId), Date.now()],
  );
  return written > 0;
}

export async function listRooms(store: Store): Promise<string[]> {
  const server = await store.server();
  const rows = await server.query('SELECT room_id FROM rooms ORDER BY room_id');
  return rows.map((row) => String(row.room_id));
}

// The newly registered room ids, in discovery order.
export async function discover(store: Store): Promise<string[]> {
  const found = await store.rooms();
  const added: string[] = [];
  for (const roomId of found) {
    if (await registerRoom(store, roomId)) added.push(roomId);
  }
  return added;
}
