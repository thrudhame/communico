// api/engine/rulebook/v8.ts — the room version 8 Rulebook: v7 +
// restricted join rooms (v8-auth-rules.md:72-78) and the inline v8
// redaction table (v8.md:42-69).
import { V8 } from './room-versions.ts';
import { checkAuthAgainstState, checkAuthChain } from './auth-rules.ts';
import { selectAuthEvents } from './select-auth-events.ts';
import { resolve } from './state-res-v2.ts';
import type { EventStore, Rulebook, StateMap } from './types.ts';

const RECOGNISED_VERSIONS: readonly string[] = [V8.identifier];

export const v8: Rulebook = {
  spec: V8,
  selectAuthEvents: (pdu, state) => selectAuthEvents(pdu, state, V8),
  checkAuthChain: (pdu, store: EventStore) =>
    checkAuthChain(pdu, store, RECOGNISED_VERSIONS, V8),
  checkAuthAgainstState: (pdu, state: StateMap, store: EventStore) =>
    checkAuthAgainstState(pdu, state, store, V8),
  resolveState: (stateSets, store: EventStore) => resolve(stateSets, store, V8),
  redactionRules: { version: V8.identifier },
};
