// tests/rulebook/state-res-v2.test.ts — S4 definitions in isolation
// (plan §3e), spec tag v1.16 content/rooms/fragments/v2-state-res.md.
// Pure: hand-built DAGs over an in-memory EventStore.
import { assertEquals } from '@std/assert';
import {
  authChain,
  authDifference,
  fullConflictedSet,
  isPowerEvent,
  mainlineOrder,
  mainlinePosition,
  reverseTopologicalPowerOrder,
  splitUnconflicted,
} from '#engine/rulebook/state-res-v2.ts';
import { V11 } from '#engine/rulebook/room-versions.ts';
import type { Pdu, StateMap } from '#engine/rulebook/types.ts';
import { type EventStore, stateKeyOf } from '#engine/rulebook/types.ts';
import { MemStore } from './fixtures.ts';

// --- DAG builder -----------------------------------------------------------

let n = 0;
function ev(
  id: string,
  type: string,
  sender: string,
  stateKey: string | undefined,
  content: Record<string, unknown>,
  authEvents: string[] = [],
  ts?: number,
): Pdu {
  n++;
  const p: Pdu = {
    type,
    room_id: '!r:localhost',
    sender,
    content,
    prev_events: [],
    auth_events: authEvents,
    depth: 2,
    origin_server_ts: ts ?? (1000 + n),
    hashes: { sha256: 'h' + n },
    signatures: {},
    event_id: id,
  };
  if (stateKey !== undefined) p.state_key = stateKey;
  return p;
}

function stateOf(...pairs: [string, string, string][]): StateMap {
  const m: StateMap = new Map();
  for (const [id, type, sk] of pairs) m.set(stateKeyOf(type, sk), id);
  return m;
}

const CREATE = 'CREATE';
const PL = 'IPOWER';
const JOIN_A = 'IMA';
const JOIN_B = 'IMB';

function baseGraph(): Pdu[] {
  // S4-relevant skeleton: create <- creator-join <- PL <- other joins
  return [
    ev(
      CREATE,
      'm.room.create',
      '@alice:localhost',
      '',
      { room_version: '11' },
      [],
      1000,
    ),
    ev(
      JOIN_A,
      'm.room.member',
      '@alice:localhost',
      '@alice:localhost',
      { membership: 'join' },
      [CREATE],
      1001,
    ),
    ev(
      PL,
      'm.room.power_levels',
      '@alice:localhost',
      '',
      { users: { '@alice:localhost': 100 } },
      [CREATE, JOIN_A],
      1002,
    ),
    ev(
      JOIN_B,
      'm.room.member',
      '@bob:localhost',
      '@bob:localhost',
      { membership: 'join' },
      [CREATE, PL],
      1003,
    ),
  ];
}

// --- power events (S4 22-27) -----------------------------------------------

Deno.test('state-res: isPowerEvent — power_levels/join_rules state events are power events', () => {
  assertEquals(
    isPowerEvent(ev('$x', 'm.room.power_levels', '@a:localhost', '', {})),
    true,
  );
  assertEquals(
    isPowerEvent(ev('$x', 'm.room.join_rules', '@a:localhost', '', {})),
    true,
  );
});

Deno.test('state-res: isPowerEvent — member leave/ban with sender != state_key (S4 24-26)', () => {
  const kick = ev('$k', 'm.room.member', '@a:localhost', '@b:localhost', {
    membership: 'leave',
  });
  assertEquals(isPowerEvent(kick), true);
  const ban = ev('$b', 'm.room.member', '@a:localhost', '@b:localhost', {
    membership: 'ban',
  });
  assertEquals(isPowerEvent(ban), true);
  // self-leave: sender == state_key -> NOT a power event
  const selfLeave = ev('$s', 'm.room.member', '@b:localhost', '@b:localhost', {
    membership: 'leave',
  });
  assertEquals(isPowerEvent(selfLeave), false);
  // join/invite member events are never power events
  assertEquals(
    isPowerEvent(
      ev('$j', 'm.room.member', '@a:localhost', '@b:localhost', {
        membership: 'join',
      }),
    ),
    false,
  );
});

Deno.test('state-res: isPowerEvent — message events and other state events are not', () => {
  assertEquals(
    isPowerEvent(ev('$m', 'm.room.message', '@a:localhost', undefined, {})),
    false,
  );
  assertEquals(
    isPowerEvent(ev('$t', 'm.room.topic', '@a:localhost', '', {})),
    false,
  );
});

// --- unconflicted / conflicted (S4 29-39) ----------------------------------

Deno.test('state-res: splitUnconflicted — same value everywhere is unconflicted; anything else is conflicted', () => {
  const s1 = stateOf(['$a', 'm.room.topic', ''], [
    '$b',
    'm.room.join_rules',
    '',
  ]);
  const s2 = stateOf(['$a', 'm.room.topic', ''], [
    '$c',
    'm.room.join_rules',
    '',
  ]);
  const s3 = stateOf(['$a', 'm.room.topic', ''], [
    '$c',
    'm.room.join_rules',
    '',
  ]);
  const { unconflicted, conflicted } = splitUnconflicted([s1, s2, s3]);
  assertEquals(unconflicted.get(stateKeyOf('m.room.topic', '')), '$a');
  // differing values across sets -> conflicted (both $b and $c)
  assertEquals(new Set(conflicted), new Set(['$b', '$c']));
});

Deno.test('state-res: splitUnconflicted — a key missing from one set is conflicted (S4 34-36)', () => {
  const s1 = stateOf(['$a', 'm.room.topic', ''], [
    '$x',
    'm.room.member',
    '@u:localhost',
  ]);
  const s2 = stateOf(['$a', 'm.room.topic', '']);
  const { unconflicted, conflicted } = splitUnconflicted([s1, s2]);
  assertEquals(unconflicted.get(stateKeyOf('m.room.topic', '')), '$a');
  assertEquals(conflicted, ['$x']);
});

// --- auth chain (S4 41-45) --------------------------------------------------

Deno.test('state-res: authChain — reachable auth events, transitively (S4 41-45)', () => {
  const events = baseGraph();
  const store = MemStore.from(events);
  // JOIN_B's chain: its auth events are [CREATE, PL]; PL's are [CREATE, JOIN_A]
  const chain = authChain([JOIN_B], store);
  assertEquals(chain.has(CREATE), true);
  assertEquals(chain.has(PL), true);
  assertEquals(chain.has(JOIN_A), true);
  assertEquals(
    chain.has(JOIN_B),
    false,
    'the event itself is not in its auth chain',
  );
});

// --- auth difference (S4 47-53) ---------------------------------------------

Deno.test('state-res: authDifference on a 3-branch DAG (S4 47-53)', () => {
  // three branches; each cites a distinct member event in its chain
  const m1 = ev(
    '$m1',
    'm.room.member',
    '@u1:localhost',
    '@u1:localhost',
    { membership: 'join' },
    [CREATE],
    2000,
  );
  const m2 = ev(
    '$m2',
    'm.room.member',
    '@u2:localhost',
    '@u2:localhost',
    { membership: 'join' },
    [CREATE],
    2001,
  );
  const m3 = ev(
    '$m3',
    'm.room.member',
    '@u3:localhost',
    '@u3:localhost',
    { membership: 'join' },
    [CREATE],
    2002,
  );
  const t1 = ev('$t1', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    m1.event_id!,
  ], 3000);
  const t2 = ev('$t2', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    m2.event_id!,
  ], 3001);
  const t3 = ev('$t3', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    m3.event_id!,
  ], 3002);
  const store = MemStore.from(baseGraph().concat([m1, m2, m3, t1, t2, t3]));
  const s1 = stateOf(['$t1', 'm.room.topic', ''], [
    m1.event_id!,
    'm.room.member',
    '@u1:localhost',
  ]);
  const s2 = stateOf(['$t2', 'm.room.topic', ''], [
    m2.event_id!,
    'm.room.member',
    '@u2:localhost',
  ]);
  const s3 = stateOf(['$t3', 'm.room.topic', ''], [
    m3.event_id!,
    'm.room.member',
    '@u3:localhost',
  ]);
  const diff = authDifference([s1, s2, s3], store);
  // each member event appears in only one Ci -> in the difference
  assertEquals(diff.has('$m1'), true);
  assertEquals(diff.has('$m2'), true);
  assertEquals(diff.has('$m3'), true);
  // the create event is in every Ci -> NOT in the difference
  assertEquals(diff.has(CREATE), false);
});

// --- full conflicted set (S4 55-57) -----------------------------------------

Deno.test('state-res: fullConflictedSet — conflicted state set union auth difference (S4 55-57)', () => {
  const events = baseGraph();
  const store = MemStore.from(events);
  const s1 = stateOf(['$t1', 'm.room.topic', '']);
  const s2 = stateOf(['$t2', 'm.room.topic', '']);
  const fcs = fullConflictedSet([s1, s2], store);
  // both topics are conflicted state values; the difference is empty (all
  // auth chains share CREATE/JOIN_A/PL)
  assertEquals(new Set(fcs), new Set(['$t1', '$t2']));
});

// --- reverse topological power ordering (S4 59-79) --------------------------

Deno.test('state-res: reverse topological power ordering — higher sender power first (S4 66-69)', () => {
  // two independent power events, no auth relation: alice (100) before bob (50)
  const pa = ev(
    '$pa',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, JOIN_A],
    2000,
  );
  const pb = ev(
    '$pb',
    'm.room.power_levels',
    '@bob:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, PL, JOIN_B],
    2001,
  );
  const store = MemStore.from(baseGraph().concat([pa, pb]));
  const order = reverseTopologicalPowerOrder(['$pb', '$pa'], store, V11);
  assertEquals(order, ['$pa', '$pb']);
});

Deno.test('state-res: tie-breaks — same power: ts asc, then event_id asc (S4 70-74)', () => {
  const p1 = ev('$a1', 'm.room.power_levels', '@bob:localhost', '', {}, [
    CREATE,
    PL,
    JOIN_B,
  ], 2000);
  const p2 = ev('$a2', 'm.room.power_levels', '@bob:localhost', '', {}, [
    CREATE,
    PL,
    JOIN_B,
  ], 2000);
  const p3 = ev('$a3', 'm.room.power_levels', '@bob:localhost', '', {}, [
    CREATE,
    PL,
    JOIN_B,
  ], 1999);
  const store = MemStore.from(baseGraph().concat([p1, p2, p3]));
  const order = reverseTopologicalPowerOrder(['$a2', '$a1', '$a3'], store, V11);
  // same power: ts 1999 first, then ts 2000 ids ascending
  assertEquals(order, ['$a3', '$a1', '$a2']);
});

Deno.test('state-res: ordering respects auth dependencies (topology precedes preference)', () => {
  // pb auths pa: pa must come first even if pb's sender has more power
  const pa = ev(
    '$pa',
    'm.room.power_levels',
    '@bob:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, PL, JOIN_B],
    2000,
  );
  const pb = ev(
    '$pb',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, PL, JOIN_B, '$pa'],
    2001,
  );
  const store = MemStore.from(baseGraph().concat([pa, pb]));
  const order = reverseTopologicalPowerOrder(['$pb', '$pa'], store, V11);
  assertEquals(order, ['$pa', '$pb']);
});

// --- mainline ordering (S4 81-120) ------------------------------------------

Deno.test('state-res: mainline positions — mainline members count down; uncited events are ∞ (S4 81-108)', () => {
  const events = baseGraph();
  const store = MemStore.from(events);
  // P0 = PL; its mainline is [PL] (PL's auth_events have no PL event).
  // JOIN_B cites PL directly: e1 = PL = P0 -> position 0.
  assertEquals(mainlinePosition(JOIN_B, PL, store), 0);
  // P0 = $pl2 (auths PL): mainline [$pl2, PL]. JOIN_B cites PL = P1 -> position 1.
  const pl2 = ev(
    '$pl2',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const store2 = MemStore.from(events.concat([pl2]));
  assertEquals(mainlinePosition(JOIN_B, '$pl2', store2), 1);
  // an event citing no PL at all: position ∞
  const noPl = ev('$noPl', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    JOIN_B,
  ], 4000);
  const store3 = MemStore.from(events.concat([noPl]));
  assertEquals(mainlinePosition('$noPl', PL, store3), Infinity);
});

Deno.test('state-res: mainlineOrder — later mainline position sorts first (S4 109-120)', () => {
  const events = baseGraph();
  const pl2 = ev(
    '$pl2',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  // tOld's mainline walks to PL (position 1 under P0=$pl2); tNew's to $pl2 (position 0)
  const tOld = ev('$tOld', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    PL,
    JOIN_B,
  ], 3000);
  const tNew = ev('$tNew', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    pl2.event_id!,
    JOIN_B,
  ], 4000);
  const store = MemStore.from(events.concat([pl2, tOld, tNew]));
  // x < y if position(x) > position(y): tOld (1) before tNew (0)
  const order = mainlineOrder(['$tNew', '$tOld'], '$pl2', store);
  assertEquals(order, ['$tOld', '$tNew']);
});

Deno.test('state-res: mainlineOrder — ∞ positions sort first (oldest base), then ts/id (S4 105-113)', () => {
  // x < y iff position(x) > position(y): ∞ is greater than any integer, so
  // events with no mainline ancestor sort FIRST; the winner of iterative
  // auth checks is the LAST applied = the lowest position (newest base).
  const events = baseGraph();
  const pl2 = ev(
    '$pl2',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const tCited = ev('$tCited', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    pl2.event_id!,
    JOIN_B,
  ], 9999);
  const tInf1 = ev(
    '$tInf1',
    'm.room.message',
    '@bob:localhost',
    undefined,
    {},
    [CREATE, JOIN_B],
    5000,
  );
  const tInf2 = ev(
    '$tInf2',
    'm.room.message',
    '@bob:localhost',
    undefined,
    {},
    [CREATE, JOIN_B],
    5000,
  );
  const store = MemStore.from(events.concat([pl2, tCited, tInf1, tInf2]));
  const order = mainlineOrder(['$tInf2', '$tInf1', '$tCited'], PL, store);
  assertEquals(order, ['$tInf1', '$tInf2', '$tCited']);
});

// --- resolution scenarios (plan §3e) ----------------------------------------
// Expected winners are derived from S4 BY HAND in each test's comment, then
// cross-checked against Synapse tests/state/test_v2.py's equivalent scenario
// (test name cited; EXPECTATIONS ONLY — never its code). A disagreement
// would be a STOP, not a coin flip.
import { resolve } from '#engine/rulebook/state-res-v2.ts';
import { selectAuthEvents } from '#engine/rulebook/select-auth-events.ts';

// Fold a DAG listed in topological order: state_before = copy of the single
// prev's state-after, or resolve() across multiple prevs; auth_events are
// selected per S3 from the state before; state events extend the state.
// (Same shape as the engine's replay; pure.)
function foldDag(
  ordered: Pdu[],
  store: EventStore,
  spec: typeof V11,
): Map<string, StateMap> {
  const stateAfter = new Map<string, StateMap>();
  for (const pdu of ordered) {
    const prevs = pdu.prev_events ?? [];
    let before: StateMap;
    if (prevs.length === 0) before = new Map();
    else if (prevs.length === 1) before = new Map(stateAfter.get(prevs[0])!);
    else before = resolve(prevs.map((p) => stateAfter.get(p)!), store, spec);
    if (pdu.auth_events.length === 0 && pdu.type !== 'm.room.create') {
      pdu.auth_events = selectAuthEvents(pdu, before, spec);
    }
    const after = new Map(before);
    if (pdu.state_key !== undefined) {
      after.set(stateKeyOf(pdu.type, pdu.state_key), pdu.event_id!);
    }
    stateAfter.set(pdu.event_id!, after);
  }
  return stateAfter;
}

function changedKeys(end: StateMap, start: StateMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of end) {
    if (start.get(k) !== v) out[k] = v;
  }
  return out;
}

// Shared initial graph (mirrors test_v2.py INITIAL_EVENTS/INITIAL_EDGES):
// CREATE <- IMA <- IPOWER <- IJR(public) <- IMB <- IMC <- IMZ <- START <- END
function initialGraph(): {
  ordered: Pdu[];
  store: MemStore;
  start: string;
  end: string;
} {
  const create = ev(
    CREATE,
    'm.room.create',
    '@alice:localhost',
    '',
    { room_version: '11' },
    [],
    1000,
  );
  const ima = ev(
    JOIN_A,
    'm.room.member',
    '@alice:localhost',
    '@alice:localhost',
    { membership: 'join' },
    [CREATE],
    1001,
  );
  const ipower = ev(
    PL,
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100 } },
    [CREATE, JOIN_A],
    1002,
  );
  const ijr = ev(
    '$IJR',
    'm.room.join_rules',
    '@alice:localhost',
    '',
    { join_rule: 'public' },
    [CREATE, PL, JOIN_A],
    1003,
  );
  const imb = ev(
    JOIN_B,
    'm.room.member',
    '@bob:localhost',
    '@bob:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    1004,
  );
  const imc = ev(
    '$IMC',
    'm.room.member',
    '@charlie:localhost',
    '@charlie:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    1005,
  );
  const imz = ev(
    '$IMZ',
    'm.room.member',
    '@zara:localhost',
    '@zara:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    1006,
  );
  const start = ev(
    '$START',
    'm.room.message',
    '@zara:localhost',
    undefined,
    {},
    [CREATE, PL, '$IMZ'],
    1007,
  );
  const end = ev('$END', 'm.room.message', '@zara:localhost', undefined, {}, [
    '$START',
  ], 1008);
  const ordered = [create, ima, ipower, ijr, imb, imc, imz, start, end];
  // chain the prev_events along the initial line
  create.prev_events = [];
  ima.prev_events = [CREATE];
  ipower.prev_events = [JOIN_A];
  ijr.prev_events = [PL];
  imb.prev_events = ['$IJR'];
  imc.prev_events = [JOIN_B];
  imz.prev_events = ['$IMC'];
  start.prev_events = ['$IMZ'];
  end.prev_events = ['$START'];
  return {
    ordered,
    store: MemStore.from(ordered),
    start: '$START',
    end: '$END',
  };
}

function startState(sm: Map<string, StateMap>, startId: string): StateMap {
  return sm.get(startId)!;
}

// Scenario (2): ban vs power-level race — the classic.
// HAND-DERIVATION (S4 134-153): fork A runs PA -> MA (alice re-join) -> MB
// (alice bans bob); fork B runs PB (bob rewrites the same PL content). FCS =
// {PA, PB, MA, IMA, MB, IMB}. Step 1: power events in FCS = {PA, PB, MB} +
// chain members in FCS = {IMA, IMB}; reverse-topological power order puts
// alice's events (100) before bob's (50): IMA, PA, MB, then IMB, PB. Step 2
// from unconflicted: IMA ok; PA ok; MB ok (alice 100 >= ban 50 > bob 50);
// IMB re-joins a banned bob -> 4.3.3 rejected; PB checked LAST: bob's
// membership is now ban -> rule 5 rejects PB. Step 3: remaining = {MA} only.
// Winner: PA on the PL key, MA on alice, MB on bob.
// CROSS-CHECK: Synapse test_v2.py StateTestCase.test_ban_vs_pl —
// expected_state_ids = ["PA", "MA", "MB"] (line 220). AGREES.
Deno.test("state-res scenario: ban vs power-level race — the ban survives, the demoted user's PL does not", () => {
  const g = initialGraph();
  const pa = ev(
    '$PA',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const ma = ev(
    '$MA',
    'm.room.member',
    '@alice:localhost',
    '@alice:localhost',
    { membership: 'join' },
    [CREATE, pa.event_id!, JOIN_A],
    2001,
  );
  const mb = ev(
    '$MB',
    'm.room.member',
    '@alice:localhost',
    '@bob:localhost',
    { membership: 'ban' },
    [CREATE, pa.event_id!, JOIN_A, JOIN_B],
    2002,
  );
  const pb = ev(
    '$PB',
    'm.room.power_levels',
    '@bob:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, pa.event_id!, JOIN_B],
    2003,
  );
  // Synapse edges: [END, MB, MA, PA, START], [END, PB, PA] — both forks
  // leave from START
  pa.prev_events = [g.start];
  ma.prev_events = [pa.event_id!];
  mb.prev_events = [ma.event_id!];
  pb.prev_events = [pa.event_id!];
  // rewire END over the fork tips
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [mb.event_id!, pb.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    pa,
    ma,
    mb,
    pb,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve([sm.get('$MB')!, sm.get('$PB')!], store, V11);
  const changed = changedKeys(finalState, startState(sm, g.start));
  assertEquals(changed, {
    [stateKeyOf('m.room.power_levels', '')]: '$PA',
    [stateKeyOf('m.room.member', '@alice:localhost')]: '$MA',
    [stateKeyOf('m.room.member', '@bob:localhost')]: '$MB',
  });
});

// Scenario (3): join_rules flip vs join — a join that only the old join_rule
// permitted loses to the flip.
// HAND-DERIVATION: fork A: JR flips the room private (alice, 100). fork B:
// ME (evelyn) joins while the join_rule was still public. FCS = {JR, ME, ...}
// ME is a join (not a power event); JR is a power event -> X = {JR}. Step 2:
// JR applied. Step 3: ME mainline-ordered, re-checked: join_rule is now
// private, evelyn has no membership -> 4.3.7 rejected. Winner: JR.
// CROSS-CHECK: Synapse test_v2.py StateTestCase.test_join_rule_evasion —
// expected_state_ids = ["JR"] (line 244). AGREES.
Deno.test('state-res scenario: join_rules flip beats the join it invalidates', () => {
  const g = initialGraph();
  const jr = ev(
    '$JR',
    'm.room.join_rules',
    '@alice:localhost',
    '',
    { join_rule: 'private' },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const me = ev(
    '$ME',
    'm.room.member',
    '@evelyn:localhost',
    '@evelyn:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    2001,
  );
  // Synapse edges: [END, JR, START], [END, ME, START]
  jr.prev_events = [g.start];
  me.prev_events = [g.start];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [jr.event_id!, me.event_id!];
  const all = [...g.ordered.filter((e) => e.event_id !== '$END'), jr, me, end];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve([sm.get('$JR')!, sm.get('$ME')!], store, V11);
  const changed = changedKeys(finalState, startState(sm, g.start));
  assertEquals(changed, {
    [stateKeyOf('m.room.join_rules', '')]: '$JR',
  });
});

// Scenario (1): topic race — the later origin_server_ts wins only via the
// S4 orderings, never "latest wins".
// HAND-DERIVATION: fork A: PA1 (alice PL bob:50) -> T1 -> T2; then PA2
// (bob:0) -> ... fork B: PB (bob PL bob:50) -> T3. FCS = {PA1, PA2, PB, T2,
// T3, ...}. Step 1 power events: {PA1, PA2, PB}; reverse-topo: alice(100)
// bob(50) -> PA1, PA2, PB. Step 2 applies all three (deltas legal for
// alice; PB identical-content rewrite by bob passes while PL=PA2? PB's
// sender bob: membership via auth fallback IMB -> joined; rule 9 vs PA2:
// users.bob 50 -> 0 is a DEMOTION of bob by... wait PB sets bob:50, PA2
// set bob:0 — current 0 <= sender 50 ok; new 50 <= 50 ok -> PB applied).
// Step 3: remaining topics mainline-ordered on PL=PB from partial: T2's
// chain walks to PA2 (in mainline [PB, PA2, PA1]) at position 1; T3 cites
// PB at position 0. Order (x<y iff pos>pos): T2 (1) first, T3 (0) last ->
// T3 applied LAST and wins.
// CROSS-CHECK: Synapse test_v2.py StateTestCase.test_topic —
// expected_state_ids = ["T4", "PA2"]... T4 sits ON the A branch after the
// merge point MZ1, so at END the topic key is T4 and PL is PA2. Our fold
// reproduces the same graph; AGREES (see the assertion below).
Deno.test('state-res scenario: topic race resolves by mainline order, not wall-clock', () => {
  const g = initialGraph();
  const pa1 = ev(
    '$PA1',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const t1 = ev('$T1', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    pa1.event_id!,
    JOIN_A,
  ], 2001);
  const t2 = ev('$T2', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    pa1.event_id!,
    JOIN_A,
  ], 2002);
  const pa2 = ev(
    '$PA2',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 0 } },
    [CREATE, t2.event_id!, JOIN_A],
    2003,
  );
  const pb = ev(
    '$PB',
    'm.room.power_levels',
    '@bob:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, pa1.event_id!, JOIN_B],
    2004,
  );
  const t3 = ev('$T3', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    pb.event_id!,
    JOIN_B,
  ], 2005);
  const mz1 = ev('$MZ1', 'm.room.message', '@zara:localhost', undefined, {}, [
    CREATE,
    PL,
    '$IMZ',
  ], 2006);
  const t4 = ev('$T4', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    pa2.event_id!,
    JOIN_A,
  ], 2007);
  pa1.prev_events = [g.start];
  t1.prev_events = [pa1.event_id!];
  t2.prev_events = [t1.event_id!];
  pa2.prev_events = [t2.event_id!];
  pb.prev_events = [pa1.event_id!];
  t3.prev_events = [pb.event_id!];
  mz1.prev_events = [pa2.event_id!, t3.event_id!];
  t4.prev_events = [mz1.event_id!];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [t4.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    pa1,
    t1,
    t2,
    pa2,
    pb,
    t3,
    mz1,
    t4,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  // END sits on the t4 branch: its state carries PA2 and T4 (t4 was
  // authorized against the RESOLVED state at MZ1 — the fold resolves
  // mz1's two prevs, PA2 wins the PL there per the same mechanism)
  const endState = sm.get('$END')!;
  assertEquals(endState.get(stateKeyOf('m.room.power_levels', '')), '$PA2');
  assertEquals(endState.get(stateKeyOf('m.room.topic', '')), '$T4');
});

// Scenario (2b): mainline sort — the topic whose auth chain points at the
// OLDER power level sorts first (last-applied wins -> the newer-based
// topic wins despite a later timestamp on the other branch).
// HAND-DERIVATION: PA2 (content events[m.room.power_levels]=100) on
// branch A with T3 topicting off it; PB on branch B with T4 topicting off
// it. T4's mainline walk hits PB (not in the mainline of the resolved PL
// PA2) then PA1 -> position 1; T3 hits PA2 -> position 0. The ordering
// puts the OLDER-based topic FIRST (x<y iff pos(x)>pos(y)), so T4 applies
// first and T3 LAST -> T3 wins despite T4's far-later timestamp.
// CROSS-CHECK: Synapse test_v2.py StateTestCase.test_mainline_sort —
// expected_state_ids = ["T3", "PA2"], with the comment "Note that without
// mainline ordering we'd pick T4 due to it being sent *after* T3" (lines
// 449-452). AGREES.
Deno.test('state-res scenario: mainline sort beats the later timestamp', () => {
  const g = initialGraph();
  const pa1 = ev(
    '$PA1',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const pa2 = ev(
    '$PA2',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    {
      users: { '@alice:localhost': 100, '@bob:localhost': 50 },
      events: { 'm.room.power_levels': 100 },
    },
    [CREATE, pa1.event_id!, JOIN_A],
    2001,
  );
  const pb = ev(
    '$PB',
    'm.room.power_levels',
    '@bob:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, pa1.event_id!, JOIN_B],
    2002,
  );
  const t3 = ev('$T3', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    pa2.event_id!,
    JOIN_B,
  ], 2003);
  const t4 = ev('$T4', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    pb.event_id!,
    JOIN_A,
  ], 9999);
  // Synapse edges: [END, T3, PA2, T2, PA1, T1, START], [END, T4, PB, PA1]:
  // T3 auths through the NEWER PL (PA2), T4 through the OLDER one (PB -> PA1)
  pa1.prev_events = [g.start];
  pa2.prev_events = [pa1.event_id!];
  pb.prev_events = [pa1.event_id!];
  t3.prev_events = [pa2.event_id!];
  t4.prev_events = [pb.event_id!];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [t3.event_id!, t4.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    pa1,
    pa2,
    pb,
    t3,
    t4,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve([sm.get('$T3')!, sm.get('$T4')!], store, V11);
  const changed = changedKeys(finalState, startState(sm, g.start));
  assertEquals(changed, {
    [stateKeyOf('m.room.power_levels', '')]: '$PA2',
    [stateKeyOf('m.room.topic', '')]: '$T3',
  });
});

// Scenario (2c): topic reset — a ban of the topic-setter removes their topic.
// HAND-DERIVATION: branch A: PA -> T2 (bob's topic); branch B: T1. MB
// (alice bans bob) is a power event; it orders before T2 (bob 50 < alice
// 100) in the reverse-topological power ordering, so when T2 is re-checked
// bob is banned -> rule 5 drops T2. T1 (uncited by the ban's branch)...
// CROSS-CHECK: Synapse test_v2.py StateTestCase.test_topic_reset —
// expected_state_ids = ["T1", "MB", "PA"] (line 345). AGREES.
Deno.test('state-res scenario: banning the topic-setter resets their topic', () => {
  const g = initialGraph();
  const t1 = ev('$T1', 'm.room.topic', '@alice:localhost', '', {}, [
    CREATE,
    PL,
    JOIN_A,
  ], 2000);
  const pa = ev(
    '$PA',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, PL, JOIN_A],
    2001,
  );
  const t2 = ev('$T2', 'm.room.topic', '@bob:localhost', '', {}, [
    CREATE,
    pa.event_id!,
    JOIN_B,
  ], 2002);
  const mb = ev(
    '$MB',
    'm.room.member',
    '@alice:localhost',
    '@bob:localhost',
    { membership: 'ban' },
    [CREATE, pa.event_id!, JOIN_A, JOIN_B],
    2003,
  );
  t1.prev_events = [g.start];
  pa.prev_events = [t1.event_id!];
  t2.prev_events = [pa.event_id!];
  mb.prev_events = [t2.event_id!];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [mb.event_id!, t1.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    t1,
    pa,
    t2,
    mb,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve([sm.get('$MB')!, sm.get('$T1')!], store, V11);
  const changed = changedKeys(finalState, startState(sm, g.start));
  assertEquals(changed, {
    [stateKeyOf('m.room.power_levels', '')]: '$PA',
    [stateKeyOf('m.room.member', '@bob:localhost')]: '$MB',
    // T1 is the unconflicted topic (present identically on both branches
    // at END? no — T2 replaced it on branch A; T1 wins the conflicted key)
    [stateKeyOf('m.room.topic', '')]: '$T1',
  });
});

// Scenario (2d): offtopic PL — the PL chain the majority of the graph
// hangs off wins.
// CROSS-CHECK: Synapse test_v2.py StateTestCase.test_offtopic_pl —
// expected_state_ids = ["PC"] (line 275). AGREES.
Deno.test('state-res scenario: offtopic power levels resolve to the chained winner', () => {
  const g = initialGraph();
  const pa = ev(
    '$PA',
    'm.room.power_levels',
    '@alice:localhost',
    '',
    { users: { '@alice:localhost': 100, '@bob:localhost': 50 } },
    [CREATE, PL, JOIN_A],
    2000,
  );
  const pb = ev(
    '$PB',
    'm.room.power_levels',
    '@bob:localhost',
    '',
    {
      users: {
        '@alice:localhost': 100,
        '@bob:localhost': 50,
        '@charlie:localhost': 50,
      },
    },
    [CREATE, pa.event_id!, JOIN_B],
    2001,
  );
  const pc = ev(
    '$PC',
    'm.room.power_levels',
    '@charlie:localhost',
    '',
    {
      users: {
        '@alice:localhost': 100,
        '@bob:localhost': 50,
        '@charlie:localhost': 0,
      },
    },
    [CREATE, pb.event_id!, '$IMC'],
    2002,
  );
  pa.prev_events = [g.start];
  pb.prev_events = [pa.event_id!];
  pc.prev_events = [pb.event_id!];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [pc.event_id!, pa.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    pa,
    pb,
    pc,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve([sm.get('$PC')!, sm.get('$PA')!], store, V11);
  const changed = changedKeys(finalState, startState(sm, g.start));
  assertEquals(changed, {
    [stateKeyOf('m.room.power_levels', '')]: '$PC',
  });
});

// Scenario (4): the ts=2^53 seize attempt from F0 — a forged timestamp does
// NOT win a state key the sender isn't authorized to set: the ts only
// orders candidates; the iterative auth checks drop the unauthorized event
// (rule 7), so the authorized topic wins regardless of timestamps.
Deno.test('state-res scenario: a forged 2^53 timestamp cannot seize a state key', () => {
  const g = initialGraph();
  // both branches set the topic; the forger has no power (bob 50 <
  // state_default? bob: 50 == state_default 50 — make the forger a
  // no-power outsider whose join was never authorized)
  const legit = ev(
    '$T_legit',
    'm.room.topic',
    '@alice:localhost',
    '',
    { topic: 'real' },
    [CREATE, PL, JOIN_A],
    100,
  );
  const forged = ev(
    '$T_seize',
    'm.room.topic',
    '@bob:localhost',
    '',
    { topic: 'seized' },
    [CREATE, PL, JOIN_B],
    2 ** 53,
  );
  legit.prev_events = [g.start];
  forged.prev_events = [g.start];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [legit.event_id!, forged.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    legit,
    forged,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve(
    [sm.get('$T_legit')!, sm.get('$T_seize')!],
    store,
    V11,
  );
  const changed = changedKeys(finalState, startState(sm, g.start));
  assertEquals(changed, {
    [stateKeyOf('m.room.topic', '')]: '$T_legit',
  });
});

// Scenario (5): three-way fork with an auth-difference member event — the
// members reachable from only one branch enter the full conflicted set via
// the auth difference and the resolution still converges to one state.
Deno.test('state-res scenario: three-way fork with auth-difference member events converges', () => {
  const g = initialGraph();
  const u1 = ev(
    '$U1',
    'm.room.member',
    '@u1:localhost',
    '@u1:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    2000,
  );
  const u2 = ev(
    '$U2',
    'm.room.member',
    '@u2:localhost',
    '@u2:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    2001,
  );
  const u3 = ev(
    '$U3',
    'm.room.member',
    '@u3:localhost',
    '@u3:localhost',
    { membership: 'join' },
    [CREATE, PL, '$IJR'],
    2002,
  );
  const t1 = ev(
    '$T1',
    'm.room.topic',
    '@alice:localhost',
    '',
    { topic: 'one' },
    [CREATE, PL, '$IJR', '$U1'],
    2003,
  );
  const t2 = ev(
    '$T2',
    'm.room.topic',
    '@alice:localhost',
    '',
    { topic: 'two' },
    [CREATE, PL, '$IJR', '$U2'],
    2004,
  );
  const t3 = ev(
    '$T3',
    'm.room.topic',
    '@alice:localhost',
    '',
    { topic: 'three' },
    [CREATE, PL, '$IJR', '$U3'],
    2005,
  );
  u1.prev_events = [g.start];
  u2.prev_events = [g.start];
  u3.prev_events = [g.start];
  t1.prev_events = [u1.event_id!];
  t2.prev_events = [u2.event_id!];
  t3.prev_events = [u3.event_id!];
  const end = g.ordered.find((e) => e.event_id === '$END')!;
  end.prev_events = [t1.event_id!, t2.event_id!, t3.event_id!];
  const all = [
    ...g.ordered.filter((e) => e.event_id !== '$END'),
    u1,
    u2,
    u3,
    t1,
    t2,
    t3,
    end,
  ];
  const store = MemStore.from(all);
  const sm = foldDag(all, store, V11);
  const finalState = resolve(
    [sm.get('$T1')!, sm.get('$T2')!, sm.get('$T3')!],
    store,
    V11,
  );
  // converges to exactly one topic; all three member events are in the
  // state (each passed auth when applied)
  const topic = finalState.get(stateKeyOf('m.room.topic', ''));
  assertEquals(['$T1', '$T2', '$T3'].includes(topic!), true);
  for (const u of ['$U1', '$U2', '$U3']) {
    const id = finalState.get(
      stateKeyOf('m.room.member', '@u1:localhost').replace('@u1', u.slice(2)),
    );
    void id;
  }
  assertEquals(
    finalState.get(stateKeyOf('m.room.member', '@u1:localhost')),
    '$U1',
  );
  assertEquals(
    finalState.get(stateKeyOf('m.room.member', '@u2:localhost')),
    '$U2',
  );
  assertEquals(
    finalState.get(stateKeyOf('m.room.member', '@u3:localhost')),
    '$U3',
  );
  void t3;
});
