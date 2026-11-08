// api/engine/rulebook/v3.ts — the room version 3 Rulebook: the shared
// rules with the V3 flags (room-versions.ts) — v1 numbering, the
// aliases auth rule, stringy power levels, v1-redactions, standard
// base64 event ids (v3.md:57-62).
import { V3 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

// Rule 1.3 recognises the versions THIS rulebook implements — its own
// version family.
const RECOGNISED_VERSIONS: readonly string[] = [V3.identifier];

export const v3: Rulebook = {
  spec: V3,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V3),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V3),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V3),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V3),
  redactionRules: { version: V3.identifier },
};
