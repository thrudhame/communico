// api/engine/rulebook/index.ts — the rulebook registry (plan §3a): the
// moved policy.ts surface. Unknown versions never get a default.
import { v10 } from './v10.ts';
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
export { V10, V11, V12 } from './room-versions.ts';

// '10'/'11'/'12' -> their rulebooks (the v12 plan; the older-versions
// plan extends the family downward from here).
const registry = new Map<string, Rulebook>([
  [v10.spec.identifier, v10],
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
