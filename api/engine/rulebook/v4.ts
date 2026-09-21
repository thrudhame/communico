// api/engine/rulebook/v4.ts — the room version 4 Rulebook: v3 with
// URL-safe event ids (v4-event-ids.md:3-12).
import { V4 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

const RECOGNISED_VERSIONS: readonly string[] = [V4.identifier];

export const v4: Rulebook = {
  spec: V4,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V4),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V4),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V4),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V4),
  redactionRules: { version: V4.identifier },
};
