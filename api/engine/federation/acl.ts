// Unknown/OOB rooms have no authoritative ACL. Never create a room, trust
// stripped state, or turn a failed storage read into an absent ACL.
import { openRoom } from '#engine/room/index.ts';
import { aclAllows, assertAcl } from '#engine/room/acl.ts';
import type { Store } from '#engine/store/index.ts';

export async function roomAllows(
  store: Store,
  roomId: string,
  server: string,
): Promise<boolean> {
  let room;
  try {
    room = await openRoom(store, roomId);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  return await room.tx((tx) => aclAllows(tx, server));
}

export async function assertRoomAcl(
  store: Store,
  roomId: string,
  server: string,
): Promise<void> {
  let room;
  try {
    room = await openRoom(store, roomId);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  await room.tx((tx) => assertAcl(tx, server));
}
