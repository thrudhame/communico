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
import { stateKeyOf } from '#engine/rulebook/types.ts';
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
