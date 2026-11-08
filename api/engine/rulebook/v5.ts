// api/engine/rulebook/v5.ts — the room version 5 Rulebook: v4 with
// signing-key validity enforcement (v5-signing-requirements.md:2-16 —
// recorded on the spec; the effect is federation, M5).
import { V5 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

const RECOGNISED_VERSIONS: readonly string[] = [V5.identifier];

export const v5: Rulebook = {
  spec: V5,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V5),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V5),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V5),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V5),
  redactionRules: { version: V5.identifier },
};
