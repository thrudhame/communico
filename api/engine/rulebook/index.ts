// api/engine/rulebook/index.ts — the rulebook registry (plan §3a): the
// moved policy.ts surface. Unknown versions never get a default.
import { v11 } from './v11.ts';
import type { Rulebook } from './types.ts';

export { stateKeyOf } from './types.ts';
export type {
  EventStore,
  Pdu,
  RoomVersionSpec,
  Rulebook,
  StateMap,
  Verdict,
} from './types.ts';
export { V11, V12 } from './room-versions.ts';

// '11' -> the real v11 rulebook. V12 is DECLARED (room-versions.ts) but
// NOT registered — registration is the v12 plan's first line (plan §3a).
const registry = new Map<string, Rulebook>([[v11.spec.identifier, v11]]);

export function getRulebook(roomVersion: unknown): Rulebook {
  if (typeof roomVersion !== 'string' || !registry.has(roomVersion)) {
    throw new Error('M_UNSUPPORTED_ROOM_VERSION: ' + String(roomVersion));
  }
  return registry.get(roomVersion as string)!;
}

export function supportedRoomVersions(): string[] {
  return [...registry.keys()];
}
