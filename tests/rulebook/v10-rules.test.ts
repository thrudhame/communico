// tests/rulebook/v10-rules.test.ts — room version 10 (plan D6): the
// explicit creator (content.creator required — v10.md:114; the first
// join compares against it — v10.md:143) and the v9-redactions keep-list
// (v10.md:276 includes the fragment) on create/member/PL/redaction
// events. Pure corpus + eventid.ts redact() dispatch checks.
import { assertEquals } from '@std/assert';
import { checkAuthChain } from '#engine/rulebook/auth-rules.ts';
import { userPowerLevel } from '#engine/rulebook/power-levels.ts';
import { V10 } from '#engine/rulebook/room-versions.ts';
import { redact } from '#engine/eventid.ts';
import { MemStore, mkPdu } from './fixtures.ts';

const ALICE = '@alice:localhost';

function v10Create(over: Record<string, unknown> = {}) {
  return mkPdu({
    type: 'm.room.create',
    sender: ALICE,
    content: { room_version: '10', creator: ALICE, ...over },
    event_id: '$c10',
  }, '');
}

// --- rule 1.4: creator required (v10.md:114) ----------------------------------

Deno.test('v10 rule 1.4: a create without content.creator is rejected', () => {
  const pdu = v10Create({ creator: undefined });
  const v = checkAuthChain(pdu, MemStore.from([]), ['10'], V10);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '1.4');
});

Deno.test('v10 rule 1.5: a create with content.creator is allowed', () => {
  const v = checkAuthChain(v10Create(), MemStore.from([]), ['10'], V10);
  assertEquals(v.ok, true);
  // v10.md:115 — the allow is 1.5 (1.4 is the creator check); the
  // pre-ruleNumbering table printed 1.4 for both.
  if (v.ok) assertEquals(v.rule, '1.5');
});

// --- the explicit creator drives power and the first join ----------------------

Deno.test('v10: the creator-100 default reads content.creator, not the sender', () => {
  // a create authored by the server account naming alice as creator
  const create = mkPdu({
    type: 'm.room.create',
    sender: '@server:localhost',
    content: { room_version: '10', creator: ALICE },
    event_id: '$c10b',
  }, '');
  assertEquals(userPowerLevel(ALICE, null, create, V10), 100);
  assertEquals(userPowerLevel('@server:localhost', null, create, V10), 0);
});

// --- the v9-redactions keep-list (v10.md:276) ---------------------------------

Deno.test('v10 redactions: top-level keeps prev_state/origin/membership; create keeps only creator', () => {
  const create = {
    type: 'm.room.create',
    room_id: '!r:localhost',
    sender: ALICE,
    content: { creator: ALICE, room_version: '10', 'm.federate': true },
    prev_state: { x: 1 },
    origin: 'localhost',
    membership: 'join',
    event_id: '$c10',
  };
  const r = redact(create, '10');
  assertEquals(r.prev_state, { x: 1 });
  assertEquals(r.origin, 'localhost');
  assertEquals(r.membership, 'join');
  assertEquals(r.content, { creator: ALICE });
});

Deno.test('v10 redactions: member keeps no third_party_invite signed; PL drops invite; redaction content emptied', () => {
  const member = {
    type: 'm.room.member',
    room_id: '!r:localhost',
    sender: ALICE,
    state_key: '@bob:localhost',
    content: {
      membership: 'invite',
      third_party_invite: { signed: { token: 't' }, token: 't' },
      displayname: 'Bob',
    },
  };
  const rm = redact(member, '10');
  assertEquals(rm.content, { membership: 'invite' });

  const pl = redact({
    type: 'm.room.power_levels',
    room_id: '!r:localhost',
    sender: ALICE,
    state_key: '',
    content: { users: { [ALICE]: 100 }, invite: 0, ban: 50 },
  }, '10');
  assertEquals(pl.content, { users: { [ALICE]: 100 }, ban: 50 });

  const red = redact({
    type: 'm.room.redaction',
    room_id: '!r:localhost',
    sender: ALICE,
    content: { redacts: '$target', reason: 'spam' },
  }, '10');
  assertEquals(red.content, {});
});

Deno.test('v11 redactions unchanged by the dispatch (create keeps all keys; redacts kept)', () => {
  const create = redact({
    type: 'm.room.create',
    room_id: '!r:localhost',
    sender: ALICE,
    content: { room_version: '11', 'm.federate': false },
    prev_state: { x: 1 },
  }, '11');
  assertEquals(create.content, { room_version: '11', 'm.federate': false });
  assertEquals(create.prev_state, undefined);
  const red = redact({
    type: 'm.room.redaction',
    room_id: '!r:localhost',
    sender: ALICE,
    content: { redacts: '$t' },
  }, '11');
  assertEquals(red.content, { redacts: '$t' });
});
