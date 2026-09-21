// api/engine/rulebook/index.ts — the rulebook registry (plan §3a): the
// moved policy.ts surface. Unknown versions never get a default.
import { v11 } from './v11.ts';
import { v12 } from './v12.ts';
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

// '11' -> the real v11 rulebook; '12' -> the v12 rulebook (the v12 plan).
const registry = new Map<string, Rulebook>([
  [v11.spec.identifier, v11],
  [v12.spec.identifier, v12],
]);

export function getRulebook(roomVersion: unknown): Rulebook {
  if (typeof roomVersion !== 'string' || !registry.has(roomVersion)) {
    throw new Error('M_UNSUPPORTED_ROOM_VERSION: ' + String(roomVersion));
  }
  return registry.get(roomVersion as string)!;
}

export function supportedRoomVersions(): string[] {
  return [...registry.keys()];
}
