// api/engine/rulebook/v9.ts — the room version 9 Rulebook: v8 with the
// member redaction keeping join_authorised_via_users_server
// (v9.md:21-23 — the v9-redactions fragment).
import { V9 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

const RECOGNISED_VERSIONS: readonly string[] = [V9.identifier];

export const v9: Rulebook = {
  spec: V9,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V9),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V9),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V9),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V9),
  redactionRules: { version: V9.identifier },
};
