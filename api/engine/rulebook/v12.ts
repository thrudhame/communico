// api/engine/rulebook/v12.ts — the room version 12 Rulebook: the
// transcribed rules with the per-version rule numbering (rule-ids.ts),
// auth-events selection without the create (v12.md:117), and state
// resolution v2.1 (v12.md:266-274, 330-339).
import { V12 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

// Rule 1.3 recognises the versions THIS rulebook implements — its own
// version family.
const RECOGNISED_VERSIONS: readonly string[] = [V12.identifier];

export const v12: Rulebook = {
  spec: V12,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V12),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V12),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V12),
  resolveState: (stateSets, store: EventStore) =>
    resolve(stateSets, store, V12),
  redactionRules: { version: V12.identifier },
};
