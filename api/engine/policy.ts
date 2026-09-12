// api/engine/policy.ts — the per-room policy slot (F0).
// The core dispatches to the room version's rulebook and never implements
// version logic itself. `room_version` is read once per room from
// m.room.create (cached in room_directory); unknown -> never a default.
import {
  authorized as stubAuthorized,
  resolveState as stubResolveState,
  selectAuthEvents as stubSelectAuthEvents,
  stateKeyOf,
} from '#lite/web/sync/rulebook/v11-stub.js';
import type { Pdu } from './pdu.ts';

export type AuthVerdict = 'ok' | 'authchain-reject' | 'state-reject' | 'soft-fail';
// StateMap: `${type}\0${state_key}` -> event_id
export type StateMap = Map<string, string>;

export interface AuthContext {
  stateAtPrevs: StateMap;
  getEvent: (eventId: string) => Pdu | undefined;
  createEventId: string;
}

export interface Rulebook {
  version: string;
  selectAuthEvents(pdu: Pdu, ctx: AuthContext): string[];
  authorized(pdu: Pdu, ctx: AuthContext): AuthVerdict;
  resolveState(parentStateSets: StateMap[]): StateMap;
}

const v11Stub: Rulebook = {
  version: '11-stub',
  selectAuthEvents: (pdu, ctx) =>
    stubSelectAuthEvents(
      pdu as unknown as Parameters<typeof stubSelectAuthEvents>[0],
      ctx as unknown as Parameters<typeof stubSelectAuthEvents>[1],
    ) as string[],
  authorized: (pdu, ctx) =>
    stubAuthorized(
      pdu as unknown as Parameters<typeof stubAuthorized>[0],
      ctx as unknown as Parameters<typeof stubAuthorized>[1],
    ) as AuthVerdict,
  resolveState: (sets) =>
    stubResolveState(
      sets as unknown as Parameters<typeof stubResolveState>[0],
    ) as StateMap,
};

// '11' -> v11-stub (F0); the real v11/v12 family lands at M3 behind the
// same interface.
const registry = new Map<string, Rulebook>([['11', v11Stub]]);

export function getRulebook(roomVersion: unknown): Rulebook {
  if (typeof roomVersion !== 'string' || !registry.has(roomVersion)) {
    throw new Error('M_UNSUPPORTED_ROOM_VERSION: ' + String(roomVersion));
  }
  return registry.get(roomVersion as string)!;
}

export function supportedRoomVersions(): string[] {
  return [...registry.keys()];
}

export { stateKeyOf };
