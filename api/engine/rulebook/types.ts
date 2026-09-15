// api/engine/rulebook/types.ts — M3: shared types for the pure rulebook
// package. No Deno.* / #engine / pg imports — this package ships to the
// browser peer later (room-sync design). The Pdu shape is a STRUCTURAL
// copy of #engine/pdu.ts (copied, not imported — the engine imports the
// package, never the reverse).

// v11 Persistent Data Unit (structurally identical to api/engine/pdu.ts;
// event_id is derived and optional until assigned).
export interface Pdu {
  type: string;
  room_id: string;
  sender: string;
  content: Record<string, unknown>;
  state_key?: string;
  prev_events: string[];
  auth_events: string[];
  depth: number;
  origin_server_ts: number;
  hashes: { sha256: string };
  signatures: Record<string, Record<string, string>>;
  unsigned?: Record<string, unknown>;
  event_id?: string;
}

// StateMap: `${type}\0${state_key}` -> event_id
export type StateMap = Map<string, string>;

export function stateKeyOf(
  type: string,
  stateKey: string | null | undefined,
): string {
  return type + '\0' + (stateKey ?? '');
}

// Event access for the rulebook: the engine builds this over the room's
// event DAG (pure tests build it over an in-memory map).
export interface EventStore {
  get(eventId: string): Pdu | undefined;
  isRejected(eventId: string): boolean;
}

// Per-version feature flags (plan §3b). Every rule that branches on a
// version reads a flag — never `identifier === '11'`.
export interface RoomVersionSpec {
  identifier: string;
  stateResVariant: 'v2' | 'v2.1';
  // rule 2.4 / auth-events selection: the create event is selected into
  // auth_events (v1.16 note at v11.md:131; v12 removes it — v12.md:100-102)
  createInAuthEvents: boolean;
  // room id == the create event's id (v12.md:10, 63-72)
  roomIdFromCreateEvent: boolean;
  // creator = the create event's sender; no `creator` field (v11.md:85-111
  // event format; v1-11 creator-100 rule at m.room.power_levels.yaml:99-101)
  implicitRoomCreator: boolean;
  // creators hold infinite power level (v12 — power_levels.yaml:103-105)
  creatorsHaveInfinitePower: boolean;
  // integers only in m.room.power_levels (v10.md:67-74, 221-228)
  enforceIntPowerLevels: boolean;
  // join_rule `knock` (v7 feature)
  knockJoinRule: boolean;
  // join_rule `restricted` (v8 feature)
  restrictedJoinRule: boolean;
  // join_rule `knock_restricted` (v10 feature)
  knockRestrictedJoinRule: boolean;
  // v3+ redaction handling (content/rooms/fragments/v3-handling-redactions.md)
  updatedRedactionRules: boolean;
  // rule 2.5 (retroactive at v1.16): auth_events room_id must match
  // (v11.md:136-137)
  authEventsSameRoom: boolean;
}

// A verdict carries WHICH rule fired, so tests assert the rule number
// (plan §3a: e.g. '4.3.3').
export type Verdict = { ok: true } | {
  ok: false;
  rule: string;
  reason: string;
};

// The per-version policy slot (plan §3c) — replaces policy.ts's F0 shape.
export interface Rulebook {
  readonly spec: RoomVersionSpec;
  selectAuthEvents(pdu: Pdu, state: StateMap): string[];
  // Rules 1–2 against the event's own auth_events (server-server-api.md
  // 473-474, check 4: "based on the event's auth events").
  checkAuthChain(pdu: Pdu, store: EventStore): Verdict;
  // Rules 3–10 against a given state map (server-server-api.md 475-476,
  // check 5: "based on the state before the event"; also reused by
  // soft-fail and the iterative auth checks).
  checkAuthAgainstState(pdu: Pdu, state: StateMap, store: EventStore): Verdict;
  resolveState(stateSets: StateMap[], store: EventStore): StateMap;
  // Redaction keep-tables (v11 table lives in #engine/eventid.ts and is
  // unchanged by M3; the structural shape keeps the package import-free).
  redactionRules: { version: string };
}
