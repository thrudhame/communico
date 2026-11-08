// api/engine/rulebook/index.ts — the rulebook registry (plan §3a): the
// moved policy.ts surface. Unknown versions never get a default.
import { v3 } from './v3.ts';
import { v4 } from './v4.ts';
import { v5 } from './v5.ts';
import { v6 } from './v6.ts';
import { v7 } from './v7.ts';
import { v8 } from './v8.ts';
import { v9 } from './v9.ts';
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
export { V10, V11, V12, V3, V4, V5, V6, V7, V8, V9 } from './room-versions.ts';

// '3'..'12' -> their rulebooks (the older-versions plan, group A: v3–v9
// join the family; group B (v1/v2) only if a need appears).
const registry = new Map<string, Rulebook>([
  [v3.spec.identifier, v3],
  [v4.spec.identifier, v4],
  [v5.spec.identifier, v5],
  [v6.spec.identifier, v6],
  [v7.spec.identifier, v7],
  [v8.spec.identifier, v8],
  [v9.spec.identifier, v9],
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
