// api/engine/rulebook/v11.ts — the room version 11 Rulebook (plan §3a):
// wires the transcribed rules (S1), auth-events selection (S3) and state
// resolution v2 (S4) to the V11 spec flags (§3b).
import { V11 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

// Rule 1.3 recognises the versions THIS rulebook implements — its own
// version family. The v12 plan widens this when V12 registers.
const RECOGNISED_VERSIONS: readonly string[] = [V11.identifier];

export const v11: Rulebook = {
  spec: V11,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V11),
  // Rules 1-2 against the event's own auth_events (server-server-api.md
  // 473-474, S8 check 4).
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V11),
  // Rules 3-10 against a given state map (server-server-api.md 475-476,
  // S8 check 5; reused by soft-fail and the iterative auth checks).
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V11),
  // State resolution v2 (S4 134-153).
  resolveState: (stateSets, store: EventStore) =>
    resolve(stateSets, store, V11),
  // Redaction keep-tables stay in #engine/eventid.ts (v11 table unchanged;
  // the version pin there is the v12 plan's first item — plan §3d).
  redactionRules: { version: V11.identifier },
};
