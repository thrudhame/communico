// api/engine/rulebook/v6.ts — the room version 6 Rulebook: the aliases
// rule removed (v6.md:51-53), `notifications` in the PL rules
// (v6.md:55-58), strict canonical JSON and the 2^53 depth limit
// (v6-canonical-json.md, depth_v6.yaml:18-24), v6-redactions.
import { V6 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

const RECOGNISED_VERSIONS: readonly string[] = [V6.identifier];

export const v6: Rulebook = {
  spec: V6,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V6),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V6),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V6),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V6),
  redactionRules: { version: V6.identifier },
};
