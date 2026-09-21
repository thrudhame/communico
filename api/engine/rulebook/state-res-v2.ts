// api/engine/rulebook/state-res-v2.ts — state resolution algorithm v2
// (plan §3a), transcribed from spec tag v1.16,
// content/rooms/fragments/v2-state-res.md (S4):
//   power events 22-27 · unconflicted/conflicted 29-39 · auth chain 41-45 ·
//   auth difference 47-53 · full conflicted set 55-57 · reverse topological
//   power ordering 59-79 · mainline ordering 81-120 · iterative auth checks
//   122-132 · algorithm 134-153 · rejected events 155-194.
//
// Known Synapse divergences NOT reproduced (plan §2):
// - m.room.create treated as a power event (Synapse v2.py:563-568) — the
//   spec's power-event definition (S4 22-27) does not include it;
// - refusing to re-admit previously rejected events in iterative auth
//   checks (v2.py:721-734, self-described non-compliant) — S4 155-194.
import { userPowerLevel } from './power-levels.ts';
import { checkAuthAgainstState } from './auth-rules.ts';
import {
  type EventStore,
  type Pdu,
  type RoomVersionSpec,
  stateKeyOf,
  type StateMap,
} from './types.ts';

// --- S4 22-27: power events -------------------------------------------------

// A power event is a state event with type m.room.power_levels or
// m.room.join_rules, or a state event with type m.room.member where the
// membership is leave or ban and the sender does not match the state_key.
export function isPowerEvent(pdu: Pdu): boolean {
  if (pdu.state_key === undefined) return false;
  if (pdu.type === 'm.room.power_levels' || pdu.type === 'm.room.join_rules') {
    return true;
  }
  if (pdu.type === 'm.room.member') {
    const m = pdu.content?.membership;
    return (m === 'leave' || m === 'ban') && pdu.sender !== pdu.state_key;
  }
  return false;
}

// --- S4 29-39: unconflicted state map and conflicted state set --------------

export function splitUnconflicted(
  stateSets: StateMap[],
): { unconflicted: StateMap; conflicted: string[] } {
  const unconflicted = new Map<string, string>();
  const conflictedSet = new Set<string>();
  const allKeys = new Set<string>();
  for (const s of stateSets) for (const k of s.keys()) allKeys.add(k);
  for (const k of allKeys) {
    const values = new Set<string>();
    let present = true;
    for (const s of stateSets) {
      const v = s.get(k);
      if (v === undefined) {
        present = false;
        break;
      }
      values.add(v);
    }
    if (present && values.size === 1) {
      unconflicted.set(k, [...values][0]);
    } else {
      for (const s of stateSets) {
        const v = s.get(k);
        if (v !== undefined) conflictedSet.add(v);
      }
    }
  }
  return { unconflicted, conflicted: [...conflictedSet] };
}

// --- S4 41-45: auth chain ----------------------------------------------------

// The events reachable by walking auth_events links. For a set of events
// this is the UNION of each event's own chain — each chain contains "all
// of E's auth events, all of their auth events, and so on" (S4 41-45) and
// excludes only E itself; another seed reachable through the graph stays.
export function authChain(eventIds: string[], store: EventStore): Set<string> {
  const result = new Set<string>();
  for (const seed of eventIds) {
    const seen = new Set<string>();
    const queue = [...(store.get(seed)?.auth_events ?? [])];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const ev = store.get(id);
      if (ev) {
        for (const a of ev.auth_events ?? []) {
          if (!seen.has(a)) queue.push(a);
        }
      }
    }
    seen.delete(seed); // E's own chain excludes E (S4 42-45)
    for (const id of seen) result.add(id);
  }
  return result;
}

// --- S4 47-53: auth difference -----------------------------------------------

// ∪Ci − ∩Ci where Ci is the full auth chain of state Si (union of the auth
// chains of every event in Si).
export function authDifference(
  stateSets: StateMap[],
  store: EventStore,
): Set<string> {
  const chains: Set<string>[] = stateSets.map((s) =>
    authChain([...s.values()], store)
  );
  const union = new Set<string>();
  for (const c of chains) for (const id of c) union.add(id);
  const diff = new Set<string>();
  for (const id of union) {
    if (chains.every((c) => c.has(id))) diff.delete(id);
    else diff.add(id);
  }
  return diff;
}

// --- S4 55-57: full conflicted set -------------------------------------------

// v2.1 (v12.md:337-339): the full conflicted set additionally includes
// the conflicted state subgraph.
export function fullConflictedSet(
  stateSets: StateMap[],
  store: EventStore,
  spec: RoomVersionSpec,
): Set<string> {
  const { conflicted } = splitUnconflicted(stateSets);
  const diff = authDifference(stateSets, store);
  if (spec.stateResVariant === 'v2.1') {
    return new Set([
      ...conflicted,
      ...conflictedStateSubgraph(conflicted, store),
      ...diff,
    ]);
  }
  return new Set([...conflicted, ...diff]);
}

// --- v12.md:330-335: conflicted state subgraph --------------------------------

// The union of all auth_events paths between pairs of conflicted events,
// endpoints included. A node belongs iff some conflicted event reaches it
// AND it reaches some conflicted event (3d — two bounded traversals, no
// exponential path walk).
export function conflictedStateSubgraph(
  conflicted: string[],
  store: EventStore,
): Set<string> {
  const seeds = new Set(conflicted);
  // forward reachability from the seeds (auth_events direction), noting
  // reverse edges for the second pass
  const fwd = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (fwd.has(id)) continue;
    fwd.add(id);
    for (const a of store.get(id)?.auth_events ?? []) {
      const kids = childrenOf.get(a) ?? [];
      kids.push(id);
      childrenOf.set(a, kids);
      queue.push(a);
    }
  }
  // nodes from which a conflicted node is reachable (reverse walk)
  const reaches = new Set<string>();
  const rqueue = [...seeds];
  while (rqueue.length > 0) {
    const id = rqueue.pop()!;
    if (reaches.has(id)) continue;
    reaches.add(id);
    for (const kid of childrenOf.get(id) ?? []) rqueue.push(kid);
  }
  const out = new Set<string>();
  for (const id of fwd) if (reaches.has(id)) out.add(id);
  return out;
}

// --- sender power from an event's own auth_events (S4 68-69) ------------------

// "x's sender has greater power level than y's sender, when looking at
// their respective auth_events": the PL event cited in x's auth_events
// (and the create event, for the creator-100 rule) define the power.
function powerFromAuthEvents(
  event: Pdu,
  store: EventStore,
  spec: RoomVersionSpec,
): number {
  let plEvent: Pdu | null = null;
  let createEvent: Pdu | null = null;
  for (const id of event.auth_events ?? []) {
    const a = store.get(id);
    if (!a) continue;
    if (a.type === 'm.room.power_levels') plEvent = a;
    if (a.type === 'm.room.create') createEvent = a;
  }
  return userPowerLevel(event.sender, plEvent, createEvent, spec);
}

// --- S4 59-79: reverse topological power ordering -----------------------------

// Kahn's algorithm; at each step the smallest candidate by the comparison
// relation: sender power DESC, origin_server_ts ASC, event_id ASC.
export function reverseTopologicalPowerOrder(
  eventIds: string[],
  store: EventStore,
  spec: RoomVersionSpec,
): string[] {
  const ids = [...new Set(eventIds)];
  const byId = new Map(ids.map((id) => [id, store.get(id)]));
  // edges: x -> y when x is an auth event of y (x must order before y)
  const deps = new Map<string, string[]>(); // id -> auth events within the set
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    const ev = byId.get(id);
    const auth = (ev?.auth_events ?? []).filter((a) => byId.has(a));
    deps.set(id, auth);
    for (const a of auth) {
      if (!dependents.has(a)) dependents.set(a, []);
      dependents.get(a)!.push(id);
    }
  }
  const out: string[] = [];
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      deps.get(id)!.every((d) => !remaining.has(d))
    );
    if (ready.length === 0) {
      // auth cycle in the input — emit the remainder by the comparison
      // relation alone to stay deterministic (no cycle can be authored
      // through the engine; defensive only)
      for (const id of [...remaining].sort()) out.push(id);
      break;
    }
    ready.sort((x, y) => {
      const ex = byId.get(x)!;
      const ey = byId.get(y)!;
      const px = powerFromAuthEvents(ex, store, spec);
      const py = powerFromAuthEvents(ey, store, spec);
      if (px !== py) return py - px; // greater power first
      if (ex.origin_server_ts !== ey.origin_server_ts) {
        return ex.origin_server_ts - ey.origin_server_ts;
      }
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const pick = ready[0];
    out.push(pick);
    remaining.delete(pick);
  }
  return out;
}

// --- S4 81-120: mainline ordering ---------------------------------------------

// The mainline of P0: [P0, P1, ...] where Pi+1 is the m.room.power_levels
// event in the auth_events of Pi, until none.
function mainlineOf(p0: string, store: EventStore): string[] {
  const mainline = [p0];
  let cur = p0;
  for (;;) {
    const ev = store.get(cur);
    if (!ev) break;
    const next = (ev.auth_events ?? []).find(
      (a) => store.get(a)?.type === 'm.room.power_levels',
    );
    if (next === undefined) break;
    mainline.push(next);
    cur = next;
  }
  return mainline;
}

// The mainline position of e given P (S4 101-107): walk e1 = PL in e's
// auth_events, e2 = ... ; the smallest j ≥ 1 with ej in the mainline gives
// i = that mainline index; none -> ∞.
export function mainlinePosition(
  eventId: string,
  p0: string,
  store: EventStore,
): number {
  const mainline = mainlineOf(p0, store);
  const positions = new Map(mainline.map((id, i) => [id, i]));
  let cur = eventId;
  for (let j = 1;; j++) {
    const ev = store.get(cur);
    if (!ev) return Infinity;
    const next = (ev.auth_events ?? []).find(
      (a) => store.get(a)?.type === 'm.room.power_levels',
    );
    if (next === undefined) return Infinity;
    const pos = positions.get(next);
    if (pos !== undefined) return pos;
    cur = next;
    void j;
  }
}

// The mainline ordering based on P (S4 109-120): smallest to largest by —
// 1. GREATER mainline position first; 2. ts ASC; 3. event_id ASC.
export function mainlineOrder(
  eventIds: string[],
  p0: string,
  store: EventStore,
): string[] {
  const byId = new Map(eventIds.map((id) => [id, store.get(id)]));
  return [...new Set(eventIds)].sort((x, y) => {
    const px = mainlinePosition(x, p0, store);
    const py = mainlinePosition(y, p0, store);
    if (px !== py) return py - px; // greater position first
    const ex = byId.get(x)!;
    const ey = byId.get(y)!;
    if (ex.origin_server_ts !== ey.origin_server_ts) {
      return ex.origin_server_ts - ey.origin_server_ts;
    }
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// --- S4 122-132: iterative auth checks ----------------------------------------

// Apply each event (in the given order) to the working state if the
// authorization rules allow it against the state so far; state events that
// pass replace their (type, state_key) entry, everything else is ignored.
// If a key required for the check is missing from the state, the
// appropriate event from the checked event's own auth_events is used when
// that auth event is not rejected (S4 129-132).
export function iterativeAuthChecks(
  initialState: StateMap,
  sortedEventIds: string[],
  store: EventStore,
  spec: RoomVersionSpec,
): StateMap {
  const state = new Map(initialState);
  for (const id of sortedEventIds) {
    const ev = store.get(id);
    if (!ev) continue;
    // fall back to the event's own non-rejected auth events for missing keys
    const checkState = new Map(state);
    for (const a of ev.auth_events ?? []) {
      const ae = store.get(a);
      if (!ae || store.isRejected(a)) continue;
      const k = stateKeyOf(ae.type, ae.state_key ?? '');
      if (!checkState.has(k)) checkState.set(k, a);
    }
    const verdict = checkAuthAgainstState(ev, checkState, store, spec);
    if (verdict.ok && ev.state_key !== undefined) {
      state.set(stateKeyOf(ev.type, ev.state_key), id);
    }
  }
  return state;
}

// --- S4 134-153: the algorithm -------------------------------------------------

// The resolution of a set of states (S4 134-153), in five steps.
export function resolve(
  stateSets: StateMap[],
  store: EventStore,
  spec: RoomVersionSpec,
): StateMap {
  if (stateSets.length === 0) return new Map();
  if (stateSets.length === 1) return new Map(stateSets[0]);

  const { unconflicted, conflicted } = splitUnconflicted(stateSets);
  const difference = authDifference(stateSets, store);
  // S4 55-57; v2.1 (v12.md:337-339) additionally unions the conflicted
  // state subgraph (v12.md:330-335).
  const fullConflicted = new Set([...conflicted, ...difference]);
  if (spec.stateResVariant === 'v2.1') {
    for (const id of conflictedStateSubgraph(conflicted, store)) {
      fullConflicted.add(id);
    }
  }

  // Step 1: power events in the full conflicted set, enlarged by their
  // auth chains' members that also belong to the set; reverse-topological
  // power order.
  const x: string[] = [];
  for (const id of fullConflicted) {
    const ev = store.get(id);
    if (ev && isPowerEvent(ev)) x.push(id);
  }
  for (const p of [...x]) {
    for (const a of authChain([p], store)) {
      if (fullConflicted.has(a) && !x.includes(a)) x.push(a);
    }
  }
  const sortedX = reverseTopologicalPowerOrder(x, store, spec);

  // Step 2: iterative auth checks from the unconflicted map — v2.1
  // (v12.md:266-267, 425-427) starts from an EMPTY state map instead.
  let partial = iterativeAuthChecks(
    spec.stateResVariant === 'v2.1' ? new Map() : unconflicted,
    sortedX,
    store,
    spec,
  );

  // Step 3: remaining events, mainline-ordered by the partially resolved
  // state's power level.
  const rest = [...fullConflicted].filter((id) => !x.includes(id));
  const plId = partial.get(stateKeyOf('m.room.power_levels', ''));
  const orderedRest = mainlineOrder(rest, plId ?? '', store);

  // Step 4: iterative auth checks on the partial state.
  partial = iterativeAuthChecks(partial, orderedRest, store, spec);

  // Step 5: the unconflicted map wins for its keys.
  const resolved = new Map(partial);
  for (const [k, v] of unconflicted) resolved.set(k, v);
  return resolved;
}
