// api/engine/room/hooks.ts — the server stage's wiring points (4b). The
// server file is DERIVED from the room files: the room core must not
// depend on it, so the projection and the registry arrive as injected
// hooks (the room deps pattern) and the room write entry points run them
// after their commits. With no hooks installed (engine tests, a store
// without the server schema) the writes stand alone — a later startup
// roll-forward catches up.
import type { Store } from '#engine/store/index.ts';
import type { CompletionCut, CompletionTarget } from './completion.ts';
import type { Room } from './index.ts';

export type RoomHooks = {
  project: (store: Store, roomId: string) => Promise<void>;
  register: (store: Store, roomId: string) => Promise<unknown>;
  enroll?: (
    room: Room,
    self: string,
    target: CompletionCut | CompletionTarget,
  ) => void;
  complete?: (
    room: Room,
    self: string,
    target: CompletionCut | CompletionTarget,
    signal?: AbortSignal,
  ) => Promise<void>;
};

let hooks: RoomHooks | null = null;
const joinAdmissions = new WeakMap<
  Store,
  (roomId: string, userId: string, eventId?: string) => Promise<void>
>();

export type RestrictedKnowledge = 'complete' | 'partial' | 'unavailable';
const restrictedViews = new WeakMap<
  Store,
  (roomId: string) => Promise<RestrictedKnowledge>
>();

// The composition owner knows whether this store covers the whole logical
// server. Room admission never reaches into an app or a replica coordinator.
export function setRestrictedKnowledge(
  store: Store,
  view: (roomId: string) => Promise<RestrictedKnowledge>,
): void {
  restrictedViews.set(store, view);
}

export async function restrictedKnowledge(
  store: Store,
  roomId: string,
): Promise<RestrictedKnowledge> {
  return await restrictedViews.get(store)?.(roomId) ?? 'complete';
}

export function setJoinAdmission(
  store: Store,
  admission: (
    roomId: string,
    userId: string,
    eventId?: string,
  ) => Promise<void>,
): void {
  joinAdmissions.set(store, admission);
}

// Called with the room authoring lock held, before opening its transaction.
export async function admitLocalJoin(
  store: Store,
  roomId: string,
  userId: string,
  eventId?: string,
): Promise<void> {
  await joinAdmissions.get(store)?.(roomId, userId, eventId);
}

export function setRoomHooks(next: RoomHooks): void {
  hooks = next;
}

export function requireCompletionOwner(): void {
  if (hooks?.enroll === undefined) {
    throw new Error('E_COMPLETION_OWNER_MISSING');
  }
}

export function enrollCompletion(
  room: Room,
  self: string,
  target: CompletionCut | CompletionTarget,
): boolean {
  if (hooks?.enroll === undefined) return false;
  hooks.enroll(room, self, target);
  return true;
}

export function completeRoomWrite(
  room: Room,
  self: string,
  signal?: AbortSignal,
): Promise<void> | undefined {
  const complete = hooks?.complete;
  if (complete === undefined) return undefined;
  return room.tx((tx) => tx.completion.capture()).then((target) => {
    // The committed obligation belongs to the store even if this caller's
    // signal was already cancelled before its completion wait is admitted.
    enrollCompletion(room, self, target);
    return complete(room, self, target, signal);
  });
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
