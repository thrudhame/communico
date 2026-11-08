// api/engine/room/hooks.ts — the server stage's wiring points (4b). The
// server file is DERIVED from the room files: the room core must not
// depend on it, so the projection and the registry arrive as injected
// hooks (the room deps pattern) and the room write entry points run them
// after their commits. With no hooks installed (engine tests, a store
// without the server schema) the writes stand alone — a later startup
// roll-forward catches up.
import type { Store } from '#engine/store/index.ts';

export type RoomHooks = {
  project: (store: Store, roomId: string) => Promise<void>;
  register: (store: Store, roomId: string) => Promise<unknown>;
};

let hooks: RoomHooks | null = null;

export function setRoomHooks(next: RoomHooks): void {
  hooks = next;
}

// After a successful room write: project. A projection failure is logged
// and left to the next call/startup — the room write already succeeded
// (plan §2 row 5).
export async function projectAfterWrite(
  store: Store,
  roomId: string,
): Promise<void> {
  if (hooks === null) return;
  try {
    await hooks.project(store, roomId);
  } catch (error) {
    console.error(`projection failed for ${roomId}:`, error);
  }
}

// On room creation (after the room file exists — room-first): register.
// A registration failure is logged the same way — the startup discovery
// covers the window.
export async function registerCreatedRoom(
  store: Store,
  roomId: string,
): Promise<void> {
  if (hooks === null) return;
  try {
    await hooks.register(store, roomId);
  } catch (error) {
    console.error(`room registration failed for ${roomId}:`, error);
  }
}
