// tests/rulebook/v12-rules.test.ts — the v12 authorization rules (plan
// §2): rule 1.2 (room_id present → reject), 1.4 (additional_creators
// validation, the five Complement _AdditionalValidation shapes), rule 2
// (room_id must be an accepted create's id), 3.x (create never selected;
// create-missing not enforced), 10.4 (creators barred from PL users), and
// the ruleId tables (v11 vs v12 numbers for the same key). Pure:
// hand-built PDUs + an in-memory EventStore. Spec tag v1.16:
// content/rooms/v12.md:94-247.
import { assertEquals } from '@std/assert';
import {
  checkAuthAgainstState,
  checkAuthChain,
} from '#engine/rulebook/auth-rules.ts';
import { ruleId } from '#engine/rulebook/rule-ids.ts';
import { V11, V12 } from '#engine/rulebook/room-versions.ts';
import type { Pdu, StateMap } from '#engine/rulebook/types.ts';
import { stateKeyOf } from '#engine/rulebook/types.ts';
import { MemStore, mkPdu } from './fixtures.ts';

const CREATE_ID = '$c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffee';
const ROOM_ID = '!' + CREATE_ID.slice(1);
const ALICE = '@alice:localhost';
const BOB = '@bob:localhost';

function v12Create(over: Partial<Pdu> = {}): Pdu {
  return mkPdu({
    type: 'm.room.create',
    room_id: undefined,
    sender: ALICE,
    content: { room_version: '12' },
    event_id: CREATE_ID,
    ...over,
  }, '');
}

function v12Store(): MemStore {
  return MemStore.from([v12Create()]);
}

// --- ruleId tables (plan D1) -------------------------------------------------

Deno.test('ruleId: the same key prints the version’s number (v11 vs v12)', () => {
  assertEquals(ruleId(V11, 'member.join_public'), '4.3.6');
  assertEquals(ruleId(V12, 'member.join_public'), '5.3.6');
  assertEquals(ruleId(V11, 'auth.same_room'), '2.5');
  assertEquals(ruleId(V12, 'auth.same_room'), '3.5');
  assertEquals(ruleId(V11, 'pl.allow'), '9.10');
  // v12.md:246 prints "10" (spec typo duplicating 10.10) — logical 10.11
  assertEquals(ruleId(V12, 'pl.allow'), '10.11');
  assertEquals(ruleId(V11, 'allow'), '10');
  assertEquals(ruleId(V12, 'allow'), '11');
  assertEquals(ruleId(V12, 'create.allow'), '1.5');
  assertEquals(ruleId(V12, 'create.additional_creators'), '1.4');
  assertEquals(ruleId(V12, 'room_id.not_create'), '2');
  assertEquals(ruleId(V12, 'pl.creator_in_users'), '10.4');
});

// --- rule 1.2: a create carrying room_id is rejected (v12.md:98-101) ---------

Deno.test('v12 rule 1.2: create with a room_id is rejected; without is allowed', () => {
  const withId = v12Create({ room_id: ROOM_ID });
  const v1 = checkAuthChain(withId, MemStore.from([]), ['12'], V12);
  assertEquals(v1.ok, false);
  if (!v1.ok) assertEquals(v1.rule, '1.2');

  const v2 = checkAuthChain(v12Create(), MemStore.from([]), ['12'], V12);
  assertEquals(v2.ok, true);
  if (v2.ok) assertEquals(v2.rule, '1.5');
});

// --- rule 1.4: additional_creators validation (v12.md:104-106) ---------------

Deno.test('v12 rule 1.4: the five additional_creators shapes', () => {
  const cases: { value: unknown; ok: boolean }[] = [
    { value: 'not-an-array', ok: false },
    { value: ['@foo:example.com', 42], ok: false },
    { value: ['@foo:example.com', 'not-a-user-id'], ok: false },
    { value: ['@invalid:dom$ain$.com'], ok: false },
    { value: ['@foo:example.com', '@bar:baz.code'], ok: true },
  ];
  for (const tc of cases) {
    const pdu = v12Create({
      content: { room_version: '12', additional_creators: tc.value },
    });
    const v = checkAuthChain(pdu, MemStore.from([]), ['12'], V12);
    assertEquals(v.ok, tc.ok, JSON.stringify(tc.value));
    if (!v.ok && !tc.ok) assertEquals(v.rule, '1.4');
  }
});

// --- rule 2: room_id must be an accepted create's id (v12.md:108-109) --------

Deno.test('v12 rule 2: room_id that is not an accepted create is rejected', () => {
  const member = mkPdu({
    type: 'm.room.member',
    room_id: '!notacreate',
    sender: ALICE,
    content: { membership: 'join' },
    event_id: '$m1',
  }, ALICE);
  const v = checkAuthChain(member, v12Store(), ['12'], V12);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2');
});

Deno.test('v12 rule 2: a rejected create does not count', () => {
  const store = MemStore.from([v12Create()], [CREATE_ID]);
  const member = mkPdu({
    type: 'm.room.member',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { membership: 'join' },
    event_id: '$m2',
  }, ALICE);
  const v = checkAuthChain(member, store, ['12'], V12);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2');
});

// --- rule 3.x: create never selected; create-missing not enforced ------------

Deno.test('v12 rule 3.2: citing the create in auth_events is rejected', () => {
  const member = mkPdu({
    type: 'm.room.member',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { membership: 'join' },
    auth_events: [CREATE_ID],
    event_id: '$m3',
  }, ALICE);
  const v = checkAuthChain(member, v12Store(), ['12'], V12);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '3.2');
});

Deno.test('v12 rule 3: auth_events WITHOUT the create are fine (no create-missing rule)', () => {
  const pl = mkPdu({
    type: 'm.room.power_levels',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { users: { [BOB]: 50 } },
    event_id: '$pl1',
  }, '');
  const member = mkPdu({
    type: 'm.room.member',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { membership: 'join' },
    auth_events: ['$pl1'],
    event_id: '$m4',
  }, ALICE);
  const store = MemStore.from([v12Create(), pl]);
  const v = checkAuthChain(member, store, ['12'], V12);
  assertEquals(v.ok, true);
  if (v.ok) assertEquals(v.rule, '3');
});

// --- rule 10.4: creators barred from PL users (v12.md:219-221) ---------------

Deno.test('v12 rule 10.4: PL users naming a creator is rejected; others allowed', () => {
  const create = v12Create();
  const join = mkPdu({
    type: 'm.room.member',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { membership: 'join' },
    event_id: '$jA',
  }, ALICE);
  const state: StateMap = new Map([
    [stateKeyOf('m.room.create', ''), CREATE_ID],
    [stateKeyOf('m.room.member', ALICE), '$jA'],
  ]);
  const store = MemStore.from([create, join]);

  const bad = mkPdu({
    type: 'm.room.power_levels',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { users: { [ALICE]: 100 } },
    event_id: '$plBad',
  }, '');
  const v1 = checkAuthAgainstState(bad, state, store, V12);
  assertEquals(v1.ok, false);
  if (!v1.ok) assertEquals(v1.rule, '10.4');

  const extra = v12Create({
    content: { room_version: '12', additional_creators: [BOB] },
  });
  const store2 = MemStore.from([extra, join]);
  const bad2 = mkPdu({
    type: 'm.room.power_levels',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { users: { [BOB]: 100 } },
    event_id: '$plBad2',
  }, '');
  const v2 = checkAuthAgainstState(bad2, state, store2, V12);
  assertEquals(v2.ok, false);
  if (!v2.ok) assertEquals(v2.rule, '10.4');

  const good = mkPdu({
    type: 'm.room.power_levels',
    room_id: ROOM_ID,
    sender: ALICE,
    content: { users: { ['@carol:localhost']: 100 } },
    event_id: '$plGood',
  }, '');
  const v3 = checkAuthAgainstState(good, state, store, V12);
  assertEquals(v3.ok, true);
  if (v3.ok) assertEquals(v3.rule, '10.5'); // no previous PL → allow
});
