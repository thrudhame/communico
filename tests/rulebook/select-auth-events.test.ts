// tests/rulebook/select-auth-events.test.ts — S3: auth events selection
// (server-server-api.md:528-554, tag v1.16, including the changed-in v1.16
// create clause). Pure.
import { assertEquals } from '@std/assert';
import { selectAuthEvents } from '#engine/rulebook/select-auth-events.ts';
import { V11 } from '#engine/rulebook/room-versions.ts';
import type { Pdu, StateMap } from '#engine/rulebook/types.ts';
import { stateKeyOf } from '#engine/rulebook/types.ts';
import {
  CREATE_ID,
  genesisEvents,
  genesisState,
  JOIN_ALICE_ID,
  JOIN_BOB_ID,
  JOIN_DEV_ID,
  JR_INVITE_ID,
  mkPdu,
  PL_ID,
} from './fixtures.ts';

function eventById(id: string, events: Pdu[]): Pdu | undefined {
  return events.find((e) => e.event_id === id);
}

function stateFromPairs(pairs: [string, string, string][]): StateMap {
  const m: StateMap = new Map();
  for (const [id, type, sk] of pairs) m.set(stateKeyOf(type, sk), id);
  return m;
}

const G = genesisEvents();
const GS = genesisState();

// --- message event ---------------------------------------------------------

Deno.test('select-auth-events: message -> create, PL, sender member (S3 535-540)', () => {
  const pdu = mkPdu({ type: 'm.room.message', sender: '@alice:localhost' });
  assertEquals(selectAuthEvents(pdu, GS, V11), [
    CREATE_ID,
    PL_ID,
    JOIN_ALICE_ID,
  ]);
});

// --- member join/invite/knock ----------------------------------------------

Deno.test('select-auth-events: member join adds target member and join_rules (S3 542-546)', () => {
  // alice re-joining: target member (herself) == sender member (dedup),
  // join_rules included
  const pdu = mkPdu(
    {
      type: 'm.room.member',
      sender: '@alice:localhost',
      content: { membership: 'join' },
    },
    '@alice:localhost',
  );
  assertEquals(selectAuthEvents(pdu, GS, V11), [
    CREATE_ID,
    PL_ID,
    JOIN_ALICE_ID,
    JR_INVITE_ID,
  ]);
});

Deno.test('select-auth-events: invite adds the target member (S3 544)', () => {
  const pdu = mkPdu(
    {
      type: 'm.room.member',
      sender: '@dev:localhost',
      content: { membership: 'invite' },
    },
    '@bob:localhost',
  );
  // order: create, PL, sender member, then sorted tail ($join_bob < $jr_invite)
  assertEquals(
    selectAuthEvents(pdu, GS, V11),
    [CREATE_ID, PL_ID, JOIN_DEV_ID, JOIN_BOB_ID, JR_INVITE_ID],
  );
});

Deno.test('select-auth-events: knock membership selects the join_rules event (S3 545-546)', () => {
  const pdu = mkPdu(
    {
      type: 'm.room.member',
      sender: '@knock:example.org',
      content: { membership: 'knock' },
    },
    '@knock:example.org',
  );
  assertEquals(selectAuthEvents(pdu, GS, V11), [
    CREATE_ID,
    PL_ID,
    JR_INVITE_ID,
  ]);
});

// --- third_party_invite token (S3 547-550) ---------------------------------

Deno.test('select-auth-events: invite with third_party_invite selects the token event (S3 547-550)', () => {
  const TOKEN_ID = '$tpi_tok';
  const state = stateFromPairs([
    [CREATE_ID, 'm.room.create', ''],
    [PL_ID, 'm.room.power_levels', ''],
    [JOIN_DEV_ID, 'm.room.member', '@dev:localhost'],
    [TOKEN_ID, 'm.room.third_party_invite', 'tok'],
  ]);
  const pdu = mkPdu(
    {
      type: 'm.room.member',
      sender: '@dev:localhost',
      content: {
        membership: 'invite',
        third_party_invite: {
          signed: { mxid: '@t:example.org', token: 'tok' },
        },
      },
    },
    '@t:example.org',
  );
  assertEquals(
    selectAuthEvents(pdu, state, V11),
    [CREATE_ID, PL_ID, JOIN_DEV_ID, TOKEN_ID],
  );
});

// --- restricted join via join_authorised_via_users_server (S3 551-554) -----

Deno.test('select-auth-events: restricted join selects the authorising member (S3 551-554)', () => {
  const GUARD_ID = '$join_guard';
  const state = stateFromPairs([
    [CREATE_ID, 'm.room.create', ''],
    [PL_ID, 'm.room.power_levels', ''],
    [JOIN_DEV_ID, 'm.room.member', '@dev:localhost'],
    [GUARD_ID, 'm.room.member', '@guard:example.org'],
  ]);
  const pdu = mkPdu(
    {
      type: 'm.room.member',
      sender: '@zara:example.org',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@guard:example.org',
      },
    },
    '@zara:example.org',
  );
  assertEquals(
    selectAuthEvents(pdu, state, V11),
    [CREATE_ID, PL_ID, GUARD_ID],
  );
});

// --- create (S3 532) --------------------------------------------------------

Deno.test('select-auth-events: create -> [] (S3 531-532)', () => {
  const pdu = mkPdu({ type: 'm.room.create', sender: '@dev:localhost' }, '');
  assertEquals(selectAuthEvents(pdu, GS, V11), []);
});

// --- deterministic order ----------------------------------------------------

Deno.test('select-auth-events: deterministic order — create, PL, sender member, sorted tail', () => {
  // an invite whose tail (join_rules JR_INVITE_ID < target JOIN_BOB_ID)
  // must be sorted by id, not state-map iteration order
  const pdu = mkPdu(
    {
      type: 'm.room.member',
      sender: '@dev:localhost',
      content: { membership: 'invite' },
    },
    '@bob:localhost',
  );
  const out = selectAuthEvents(pdu, GS, V11);
  const head = out.slice(0, 3);
  assertEquals(head, [CREATE_ID, PL_ID, JOIN_DEV_ID]);
  assertEquals(out.slice(3), [...out.slice(3)].sort());
  // every selected id exists in state
  for (const id of out) {
    const ev = eventById(id, G);
    assertEquals(ev !== undefined, true, `selected ${id} must exist`);
  }
});
