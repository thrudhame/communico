// tests/rulebook/state-res-v2_1.test.ts — state resolution v2.1 (plan
// D5): the two Complement scenarios as pure DAGs — "starts from empty
// set" (v12.md:266-267) and "includes conflicted subgraph"
// (v12.md:330-339) — plus creator-first ordering (Infinity beats any
// integer, plan D3). Pure: hand-built PDUs + an in-memory EventStore.
import { assertEquals } from '@std/assert';
import { resolve } from '#engine/rulebook/state-res-v2.ts';
import { reverseTopologicalPowerOrder } from '#engine/rulebook/state-res-v2.ts';
import { V11, V12 } from '#engine/rulebook/room-versions.ts';
import type { Pdu, StateMap } from '#engine/rulebook/types.ts';
import { stateKeyOf } from '#engine/rulebook/types.ts';
import { MemStore, mkPdu } from './fixtures.ts';

const ALICE = '@alice:localhost';
const BOB = '@bob:localhost';
const CHARLIE = '@charlie:localhost';
const CREATOR = '@creator:localhost';

let seq = 0;
function ev(
  over: Partial<Pdu> & { type: string; sender: string },
  stateKey?: string,
): Pdu {
  seq++;
  return mkPdu({ event_id: '$v21-' + seq, ...over }, stateKey);
}

// --- Scenario 1: "starts from empty set" --------------------------------------
// Conflicted: join_rules public (stale) vs invite (current). Unconflicted:
// alice = leave. The invite event's auth chain has alice JOINED — v2
// checks it against the unconflicted map (alice=leave) and both join-rule
// events die, leaving NO join rule; v2.1 starts empty, fills from the
// event's auth events, and invite wins (v12.md:266-267).

function emptySetScenario() {
  const create = ev({
    type: 'm.room.create',
    sender: ALICE,
    content: { room_version: '12' },
  }, '');
  const joinA = ev({
    type: 'm.room.member',
    sender: ALICE,
    content: { membership: 'join' },
    auth_events: [create.event_id!],
  }, ALICE);
  const pl = ev({
    type: 'm.room.power_levels',
    sender: ALICE,
    content: { users: { [ALICE]: 100 } },
    auth_events: [create.event_id!, joinA.event_id!],
  }, '');
  const jrPublic = ev({
    type: 'm.room.join_rules',
    sender: ALICE,
    content: { join_rule: 'public' },
    auth_events: [create.event_id!, pl.event_id!, joinA.event_id!],
  }, '');
  const jrInvite = ev({
    type: 'm.room.join_rules',
    sender: ALICE,
    content: { join_rule: 'invite' },
    auth_events: [create.event_id!, pl.event_id!, joinA.event_id!],
  }, '');
  const leaveA = ev({
    type: 'm.room.member',
    sender: ALICE,
    content: { membership: 'leave' },
    auth_events: [create.event_id!, pl.event_id!, joinA.event_id!],
  }, ALICE);
  const events = [create, joinA, pl, jrPublic, jrInvite, leaveA];
  const base: [string, string][] = [
    [stateKeyOf('m.room.create', ''), create.event_id!],
    [stateKeyOf('m.room.power_levels', ''), pl.event_id!],
    [stateKeyOf('m.room.member', ALICE), leaveA.event_id!],
  ];
  const s1: StateMap = new Map([
    ...base,
    [stateKeyOf('m.room.join_rules', ''), jrInvite.event_id!],
  ]);
  const s2: StateMap = new Map([
    ...base,
    [stateKeyOf('m.room.join_rules', ''), jrPublic.event_id!],
  ]);
  return { events, s1, s2, jrInvite, jrPublic, leaveA };
}

Deno.test('v2.1 starts from the empty set: invite join rule survives; alice stays leave', () => {
  const { events, s1, s2, jrInvite, leaveA } = emptySetScenario();
  const store = MemStore.from(events);
  const resolved = resolve([s1, s2], store, V12);
  assertEquals(
    resolved.get(stateKeyOf('m.room.join_rules', '')),
    jrInvite.event_id,
  );
  assertEquals(
    resolved.get(stateKeyOf('m.room.member', ALICE)),
    leaveA.event_id,
  );
});

Deno.test('v2 contrast: the same DAG loses the join rule entirely', () => {
  const { events, s1, s2 } = emptySetScenario();
  const store = MemStore.from(events);
  const resolved = resolve([s1, s2], store, V11);
  assertEquals(resolved.get(stateKeyOf('m.room.join_rules', '')), undefined);
});

// --- Scenario 2: "includes conflicted subgraph" -------------------------------
// Conflicted: PL1 (stale) vs PL3 (current). PL2 sits on the auth path
// between them and in BOTH branches' auth chains (so the auth difference
// never supplies it). v2 rejects PL3 (bob has no power under PL1) and
// PL1 wins; v2.1's conflicted state subgraph adds PL2, so bob has 50 and
// PL3 wins (v12.md:330-339).

function subgraphScenario() {
  const create = ev({
    type: 'm.room.create',
    sender: CREATOR,
    content: { room_version: '12' },
  }, '');
  const joinC = ev({
    type: 'm.room.member',
    sender: CREATOR,
    content: { membership: 'join' },
    auth_events: [create.event_id!],
  }, CREATOR);
  const pl1 = ev({
    type: 'm.room.power_levels',
    sender: CREATOR,
    content: { users: { [ALICE]: 100 } },
    auth_events: [create.event_id!, joinC.event_id!],
  }, '');
  const joinA = ev({
    type: 'm.room.member',
    sender: ALICE,
    content: { membership: 'join' },
    auth_events: [create.event_id!, pl1.event_id!, joinC.event_id!],
  }, ALICE);
  const joinB = ev({
    type: 'm.room.member',
    sender: BOB,
    content: { membership: 'join' },
    auth_events: [create.event_id!, pl1.event_id!, joinC.event_id!],
  }, BOB);
  const pl2 = ev({
    type: 'm.room.power_levels',
    sender: ALICE,
    content: { users: { [ALICE]: 100, [BOB]: 50 } },
    auth_events: [create.event_id!, pl1.event_id!, joinA.event_id!],
  }, '');
  const pl3 = ev({
    type: 'm.room.power_levels',
    sender: BOB,
    content: { users: { [ALICE]: 100, [BOB]: 50, [CHARLIE]: 50 } },
    auth_events: [create.event_id!, pl2.event_id!, joinB.event_id!],
  }, '');
  const joinCh = ev({
    type: 'm.room.member',
    sender: CHARLIE,
    content: { membership: 'join' },
    auth_events: [create.event_id!, pl1.event_id!, joinC.event_id!],
  }, CHARLIE);
  const joinE = ev({
    type: 'm.room.member',
    sender: '@eve:localhost',
    content: { membership: 'join' },
    auth_events: [create.event_id!, pl3.event_id!, joinCh.event_id!],
  }, '@eve:localhost');
  const events = [create, joinC, pl1, joinA, joinB, pl2, pl3, joinCh, joinE];
  const members: [string, string][] = [
    [stateKeyOf('m.room.member', CREATOR), joinC.event_id!],
    [stateKeyOf('m.room.member', ALICE), joinA.event_id!],
    [stateKeyOf('m.room.member', BOB), joinB.event_id!],
    [stateKeyOf('m.room.member', CHARLIE), joinCh.event_id!],
    [stateKeyOf('m.room.member', '@eve:localhost'), joinE.event_id!],
  ];
  const correct: StateMap = new Map([
    [stateKeyOf('m.room.create', ''), create.event_id!],
    [stateKeyOf('m.room.power_levels', ''), pl3.event_id!],
    ...members,
  ]);
  const stale: StateMap = new Map([
    [stateKeyOf('m.room.create', ''), create.event_id!],
    [stateKeyOf('m.room.power_levels', ''), pl1.event_id!],
    ...members,
  ]);
  return { events, correct, stale, pl1, pl3 };
}

Deno.test('v2.1 includes the conflicted subgraph: PL3 wins over stale PL1', () => {
  const { events, correct, stale, pl3 } = subgraphScenario();
  const store = MemStore.from(events);
  const resolved = resolve([correct, stale], store, V12);
  assertEquals(
    resolved.get(stateKeyOf('m.room.power_levels', '')),
    pl3.event_id,
  );
});

Deno.test('v2 contrast: without the subgraph, stale PL1 wins', () => {
  const { events, correct, stale, pl1 } = subgraphScenario();
  const store = MemStore.from(events);
  const resolved = resolve([correct, stale], store, V11);
  assertEquals(
    resolved.get(stateKeyOf('m.room.power_levels', '')),
    pl1.event_id,
  );
});

// --- creator-first ordering (plan D3) ------------------------------------------

Deno.test('reverse topological order: a creator (Infinity) beats 2^53-1', () => {
  const create = ev({
    type: 'm.room.create',
    sender: CREATOR,
    content: { room_version: '12' },
  }, '');
  const joinC = ev({
    type: 'm.room.member',
    sender: CREATOR,
    content: { membership: 'join' },
    auth_events: [create.event_id!],
  }, CREATOR);
  const joinB = ev({
    type: 'm.room.member',
    sender: BOB,
    content: { membership: 'join' },
    auth_events: [create.event_id!, joinC.event_id!],
  }, BOB);
  const pl = ev({
    type: 'm.room.power_levels',
    sender: CREATOR,
    content: { users: { [BOB]: 9007199254740991 } }, // 2^53-1
    auth_events: [create.event_id!, joinC.event_id!],
  }, '');
  const byCreator = ev({
    type: 'm.room.join_rules',
    sender: CREATOR,
    content: { join_rule: 'invite' },
    auth_events: [create.event_id!, pl.event_id!, joinC.event_id!],
  }, '');
  const byBob = ev({
    type: 'm.room.join_rules',
    sender: BOB,
    content: { join_rule: 'knock' },
    auth_events: [create.event_id!, pl.event_id!, joinB.event_id!],
  }, '');
  const store = MemStore.from([create, joinC, joinB, pl, byCreator, byBob]);
  const order = reverseTopologicalPowerOrder(
    [byBob.event_id!, byCreator.event_id!],
    store,
    V12,
  );
  assertEquals(order, [byCreator.event_id, byBob.event_id]);
});
