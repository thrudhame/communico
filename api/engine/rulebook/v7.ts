// api/engine/rulebook/v7.ts — the room version 7 Rulebook: v6 +
// knocking (v7.md:155-161).
import { V7 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

const RECOGNISED_VERSIONS: readonly string[] = [V7.identifier];

export const v7: Rulebook = {
  spec: V7,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V7),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V7),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V7),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V7),
  redactionRules: { version: V7.identifier },
};
