// api/engine/rulebook/v10.ts — the room version 10 Rulebook: v11's rules
// with the explicit creator (content.creator, v10.md:114) and the
// v9-redactions keep-list (v10.md:276; dispatch in #engine/eventid.ts).
import { V10 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

// Rule 1.3 recognises the versions THIS rulebook implements — its own
// version family.
const RECOGNISED_VERSIONS: readonly string[] = [V10.identifier];

export const v10: Rulebook = {
  spec: V10,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V10),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V10),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V10),
  resolveState: (stateSets, store: EventStore) =>
    resolve(stateSets, store, V10),
  redactionRules: { version: V10.identifier },
};
