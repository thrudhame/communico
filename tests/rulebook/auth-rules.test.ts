// tests/rulebook/auth-rules.test.ts — table-driven corpus for the ten v11
// authorization rules, one row per spec rule number (plan §3e). Spec tag
// v1.16: content/rooms/v11.md:113-260 (rules 1-10), 262-271 (unban note).
// Pure: hand-built PDUs + a small in-memory EventStore.
import { assertEquals } from '@std/assert';
import {
  checkAuthAgainstState,
  checkAuthChain,
} from '#engine/rulebook/auth-rules.ts';
import { V11 } from '#engine/rulebook/room-versions.ts';
import type { Pdu, StateMap } from '#engine/rulebook/types.ts';
import { stateKeyOf } from '#engine/rulebook/types.ts';
import {
  CREATE_ID,
  DEFAULT_AUTH,
  genesisEvents,
  genesisState,
  JOIN_ALICE_ID,
  JOIN_BOB_ID,
  JOIN_DEV_ID,
  JR_INVITE_ID,
  MemStore,
  mkPdu,
  PL_ID,
  put,
  restrictedState,
  restrictedStore,
  stateMapOf,
  stateWithBannedBob,
  storeWithBannedBob,
} from './fixtures.ts';
// --- rule 1: m.room.create (v11.md:115-122) --------------------------------

Deno.test('auth rules 1.1: create with prev_events is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11' },
    prev_events: ['$x'],
    event_id: '$c',
  }, '');
  const v = checkAuthChain(pdu, MemStore.from([]), ['11'], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '1.1');
});

Deno.test('auth rules 1.2: create whose room_id domain differs from sender domain is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.create',
    room_id: '!r:other.example',
    sender: '@dev:localhost',
    content: { room_version: '11' },
    event_id: '$c',
  }, '');
  const v = checkAuthChain(pdu, MemStore.from([]), ['11'], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '1.2');
});

Deno.test('auth rules 1.3: create with an unrecognised room_version is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '99' },
    event_id: '$c',
  }, '');
  const v = checkAuthChain(pdu, MemStore.from([]), ['11'], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '1.3');
});

Deno.test('auth rules 1.4: a well-formed create is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11' },
    event_id: '$c',
  }, '');
  const v = checkAuthChain(pdu, MemStore.from([]), ['11'], V11);
  assertEquals(v.ok, true);
});

// --- rule 2: the event's auth_events (v11.md:123-137) ----------------------

Deno.test('auth rules 2.1: duplicate (type, state_key) entries in auth_events are rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID, JOIN_DEV_ID],
  });
  const v = checkAuthChain(pdu, MemStore.from(genesisEvents()), ['11'], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2.1');
});

Deno.test('auth rules 2.2: entries outside the selection set are rejected', () => {
  const topic = mkPdu({
    type: 'm.room.topic',
    sender: '@dev:localhost',
    event_id: '$topic',
  }, '');
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID, '$topic'],
  });
  const v = checkAuthChain(pdu, MemStore.from([...genesisEvents(), topic]), [
    '11',
  ], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2.2');
});

Deno.test('auth rules 2.3: rejected entries in auth_events are rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  });
  const v = checkAuthChain(pdu, MemStore.from(genesisEvents(), [JOIN_DEV_ID]), [
    '11',
  ], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2.3');
});

Deno.test('auth rules 2.4: auth_events without an m.room.create are rejected (v11.md:131,135)', () => {
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: [PL_ID, JOIN_DEV_ID],
  });
  const v = checkAuthChain(pdu, MemStore.from(genesisEvents()), ['11'], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2.4');
});

Deno.test('auth rules 2.5: auth_events from another room are rejected (v11.md:136-137)', () => {
  const foreign = mkPdu({
    type: 'm.room.power_levels',
    room_id: '!other:localhost',
    sender: '@dev:localhost',
    event_id: '$foreign',
  }, '');
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: [CREATE_ID, '$foreign', JOIN_DEV_ID],
  });
  const v = checkAuthChain(pdu, MemStore.from([...genesisEvents(), foreign]), [
    '11',
  ], V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '2.5');
});

Deno.test('auth rules 2: a conformant auth_events list passes the rule', () => {
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: DEFAULT_AUTH,
  });
  const v = checkAuthChain(pdu, MemStore.from(genesisEvents()), ['11'], V11);
  assertEquals(v.ok, true);
});
// --- rule 3: m.federate (v11.md:138-140) -----------------------------------

Deno.test('auth rule 3: m.federate=false rejects foreign senders', () => {
  const createNoFed = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11', 'm.federate': false },
    depth: 1,
    event_id: CREATE_ID,
  }, '');
  const state = stateMapOf(put(CREATE_ID, 'm.room.create', ''));
  const store = MemStore.from([createNoFed]);
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@out:example.org',
    auth_events: [CREATE_ID],
  });
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '3');
});

Deno.test('auth rule 3: same-domain sender passes m.federate=false', () => {
  const createNoFed = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11', 'm.federate': false },
    depth: 1,
    event_id: CREATE_ID,
  }, '');
  const state = stateMapOf(put(CREATE_ID, 'm.room.create', ''));
  const store = MemStore.from([createNoFed]);
  // member events terminate at rule 4, so exercise rule 3 with a join:
  // 4.3.4 fires first here — instead check a federated room for the allow
  // arm through a message sender.
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@dev:localhost',
    auth_events: [CREATE_ID],
  });
  const v = checkAuthAgainstState(pdu, state, store, V11);
  // no member event for the sender -> rule 5 rejects; rule 3 passed
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '5');
});

Deno.test('auth rule 3: m.federate absent (default true) lets foreign senders reach rule 5', () => {
  const state = stateMapOf(put(CREATE_ID, 'm.room.create', ''));
  const store = MemStore.from(genesisEvents());
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@out:example.org',
    auth_events: [CREATE_ID],
  });
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '5');
});

// --- rule 4: membership (v11.md:141-217) -----------------------------------

// 4.1 (v11.md:142-143)
Deno.test('auth rule 4.1: member event without state_key is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID],
  });
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.1');
});

Deno.test('auth rule 4.1: member event without content.membership is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: {},
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '@dev:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.1');
});

Deno.test('auth rule 4.1: a normal member event passes 4.1 and reaches 4.3', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, JOIN_ALICE_ID],
  }, '@alice:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  // invite join_rule + current membership join -> 4.3.4 allow
  assertEquals(v.ok, true);
});

// 4.2.1 (v11.md:144-147) — restricted-room authorised join
Deno.test('auth rule 4.2.1: join_authorised_via_users_server without a signature from that server is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: {
      membership: 'join',
      join_authorised_via_users_server: '@guard:example.org',
    },
    auth_events: [CREATE_ID, PL_ID, '$jr_restricted'],
  }, '@zara:example.org');
  const v = checkAuthAgainstState(
    pdu,
    restrictedState(),
    restrictedStore(),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.2.1');
});

Deno.test('auth rule 4.2.1: a signature entry for the authorising server passes (crypto check is the signing layer/M5)', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: {
      membership: 'join',
      join_authorised_via_users_server: '@guard:example.org',
    },
    signatures: { 'example.org': { 'ed25519:k1': 'sig' } },
    auth_events: [CREATE_ID, PL_ID, '$jr_restricted', '$guard_join'],
  }, '@zara:example.org');
  const guardJoin = mkPdu({
    type: 'm.room.member',
    sender: '@guard:example.org',
    content: { membership: 'join' },
    event_id: '$guard_join',
  }, '@guard:example.org');
  const state = restrictedState();
  state.set(stateKeyOf('m.room.member', '@guard:example.org'), '$guard_join');
  const v = checkAuthAgainstState(
    pdu,
    state,
    MemStore.from([...restrictedStore().events.values(), guardJoin]),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.3.5.2');
});

// 4.3.1 (v11.md:149-151)
Deno.test('auth rule 4.3.1: the creator join over a sole create prev is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'join' },
    prev_events: [CREATE_ID],
    auth_events: [CREATE_ID],
    depth: 2,
  }, '@dev:localhost');
  const state = stateMapOf(put(CREATE_ID, 'm.room.create', ''));
  const create = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11' },
    depth: 1,
    event_id: CREATE_ID,
  }, '');
  const v = checkAuthAgainstState(pdu, state, MemStore.from([create]), V11);
  assertEquals(v.ok, true);
});

// 4.3.2 (v11.md:152)
Deno.test('auth rule 4.3.2: a join whose sender does not match state_key is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@bob:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, JOIN_ALICE_ID],
  }, '@alice:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.3.2');
});

// 4.3.3 (v11.md:153)
Deno.test('auth rule 4.3.3: a banned sender cannot re-join', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@bob:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    stateWithBannedBob(),
    storeWithBannedBob(),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.3.3');
});

// 4.3.4 (v11.md:154-155)
Deno.test('auth rule 4.3.4: join under invite rule with current membership invite/join is allowed', () => {
  // bob accepts his invite: current membership invite
  const invitedBob = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'invite' },
    event_id: '$invited_bob',
  }, '@bob:localhost');
  const state = genesisState();
  state.set(stateKeyOf('m.room.member', '@bob:localhost'), '$invited_bob');
  const store = MemStore.from([...genesisEvents(), invitedBob]);
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@bob:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, '$invited_bob'],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, true);
});

// 4.3.5 (v11.md:156-161) — restricted rooms
Deno.test('auth rule 4.3.5.2: restricted join without an authorised user is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, '$jr_restricted'],
  }, '@zara:example.org');
  const v = checkAuthAgainstState(
    pdu,
    restrictedState(),
    restrictedStore(),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.3.5.2');
});

Deno.test('auth rule 4.3.5.2: an authorised user below the invite level is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: {
      membership: 'join',
      join_authorised_via_users_server: '@weak:example.org',
    },
    signatures: { 'example.org': { 'ed25519:k2': 'sig' } },
    auth_events: [CREATE_ID, PL_ID, '$jr_restricted', '$weak_join'],
  }, '@zara:example.org');
  const weakJoin = mkPdu({
    type: 'm.room.member',
    sender: '@weak:example.org',
    content: { membership: 'join' },
    event_id: '$weak_join',
  }, '@weak:example.org');
  const state = restrictedState();
  state.set(stateKeyOf('m.room.member', '@weak:example.org'), '$weak_join');
  const v = checkAuthAgainstState(
    pdu,
    state,
    MemStore.from([...restrictedStore().events.values(), weakJoin]),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.3.5.2');
});

Deno.test('auth rule 4.3.5.3: a sufficiently-powered authorised user passes', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: {
      membership: 'join',
      join_authorised_via_users_server: '@alice:localhost',
    },
    signatures: { localhost: { 'ed25519:x': 'sig' } },
    auth_events: [CREATE_ID, PL_ID, '$jr_restricted', '$guard_join'],
  }, '@zara:example.org');
  const guardJoin = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'join' },
    event_id: '$guard_join',
  }, '@alice:localhost');
  const state = restrictedState();
  state.set(stateKeyOf('m.room.member', '@alice:localhost'), '$guard_join');
  const v = checkAuthAgainstState(
    pdu,
    state,
    MemStore.from([...restrictedStore().events.values(), guardJoin]),
    V11,
  );
  assertEquals(v.ok, true);
});

// 4.3.6 (v11.md:162)
Deno.test('auth rule 4.3.6: anyone may join a public room', () => {
  const jr = mkPdu({
    type: 'm.room.join_rules',
    sender: '@dev:localhost',
    content: { join_rule: 'public' },
    event_id: '$jr_public',
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.join_rules', ''), '$jr_public');
  const store = MemStore.from([...genesisEvents(), jr]);
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, '$jr_public', JOIN_BOB_ID],
  }, '@zara:example.org');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, true);
});

// 4.3.7 (v11.md:163)
Deno.test('auth rule 4.3.7: join under invite rule without membership/invite is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@zara:example.org',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, JOIN_BOB_ID],
  }, '@zara:example.org');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.3.7');
});

// --- rule 5 (v11.md:218) ---------------------------------------------------

Deno.test('auth rule 5: a message from a non-joined sender is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@out:example.org',
    auth_events: DEFAULT_AUTH,
  });
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '5');
});

// 4.4 — invite (v11.md:164-189)

function tpiState(
  token: string,
  sender: string,
  publicKey: string,
): { state: StateMap; store: MemStore } {
  const tpi = mkPdu({
    type: 'm.room.third_party_invite',
    sender,
    content: { public_key: publicKey },
    event_id: '$tpi_' + token,
  }, token);
  const state = genesisState();
  state.set(stateKeyOf('m.room.third_party_invite', token), '$tpi_' + token);
  return { state, store: MemStore.from([...genesisEvents(), tpi]) };
}

function invitePdu(content: Record<string, unknown>): Pdu {
  return mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content,
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '@target:example.org');
}

Deno.test('auth rule 4.4.1.1: third-party invite to a banned target is rejected', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: {
        signed: { mxid: '@target:example.org', token: 'tok' },
      },
    }),
    stateWithBannedBob().has(stateKeyOf('m.room.member', '@target:example.org'))
      ? stateWithBannedBob()
      : state,
    store,
    V11,
  );
  // target @target:example.org is not banned here — build the real case:
  const banTarget = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    event_id: '$ban_target',
  }, '@target:example.org');
  state.set(stateKeyOf('m.room.member', '@target:example.org'), '$ban_target');
  const store2 = MemStore.from([...store.events.values(), banTarget]);
  const v2 = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: {
        signed: { mxid: '@target:example.org', token: 'tok' },
      },
    }),
    state,
    store2,
    V11,
  );
  assertEquals(v2.ok, false);
  if (!v2.ok) assertEquals(v2.rule, '4.4.1.1');
  void v;
});

Deno.test('auth rule 4.4.1.2: third_party_invite without signed is rejected', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({ membership: 'invite', third_party_invite: {} }),
    state,
    store,
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.1.2');
});

Deno.test('auth rule 4.4.1.3: signed without mxid/token is rejected', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: { signed: { mxid: '@target:example.org' } },
    }),
    state,
    store,
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.1.3');
});

Deno.test('auth rule 4.4.1.4: mxid not matching state_key is rejected', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: {
        signed: { mxid: '@other:example.org', token: 'tok' },
      },
    }),
    state,
    store,
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.1.4');
});

Deno.test('auth rule 4.4.1.5: no third_party_invite event for the token is rejected', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: {
        signed: { mxid: '@target:example.org', token: 'other-token' },
      },
    }),
    state,
    store,
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.1.5');
});

Deno.test('auth rule 4.4.1.6: a different sender than the third_party_invite is rejected', () => {
  const { state, store } = tpiState('tok', '@alice:localhost', 'pubkey1');
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: {
      membership: 'invite',
      third_party_invite: {
        signed: { mxid: '@target:example.org', token: 'tok' },
      },
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '@target:example.org');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.1.6');
});

Deno.test('auth rule 4.4.1.7: a signature matching a public key allows the invite', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: {
        signed: {
          mxid: '@target:example.org',
          token: 'tok',
          signatures: { 'example.org': { 'ed25519:0': 'pubkey1' } },
        },
      },
    }),
    state,
    store,
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 4.4.1.8: no matching signature is rejected', () => {
  const { state, store } = tpiState('tok', '@dev:localhost', 'pubkey1');
  const v = checkAuthAgainstState(
    invitePdu({
      membership: 'invite',
      third_party_invite: {
        signed: {
          mxid: '@target:example.org',
          token: 'tok',
          signatures: { 'example.org': { 'ed25519:0': 'other-sig' } },
        },
      },
    }),
    state,
    store,
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.1.8');
});

Deno.test('auth rule 4.4.2: an invite from a non-joined sender is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@out:example.org',
    content: { membership: 'invite' },
    auth_events: [CREATE_ID, PL_ID],
  }, '@target:example.org');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.2');
});

Deno.test('auth rule 4.4.3: inviting a joined or banned target is rejected', () => {
  // @bob is joined in genesis state
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'invite' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.3');
});

Deno.test('auth rule 4.4.4: an invite at or above the invite level is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'invite' },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '@target:example.org');
  // alice: 50 >= invite level 0
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 4.4.5: an invite below the invite level is rejected', () => {
  // invite level 10 in the restricted PL; alice (50) invites fine — use a
  // level-0 outsider who IS joined. @weak joins a public room first:
  const jrPublic = mkPdu({
    type: 'm.room.join_rules',
    sender: '@dev:localhost',
    content: { join_rule: 'public' },
    event_id: '$jr_public',
  }, '');
  const weakJoin = mkPdu({
    type: 'm.room.member',
    sender: '@weak:localhost',
    content: { membership: 'join' },
    event_id: '$weak_join',
  }, '@weak:localhost');
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: { users: { '@dev:localhost': 100 }, users_default: 0, invite: 10 },
    event_id: '$pl10',
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.join_rules', ''), '$jr_public');
  state.set(stateKeyOf('m.room.member', '@weak:localhost'), '$weak_join');
  state.set(stateKeyOf('m.room.power_levels', ''), '$pl10');
  const store = MemStore.from([...genesisEvents(), jrPublic, weakJoin, pl]);
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@weak:localhost',
    content: { membership: 'invite' },
    auth_events: [CREATE_ID, PL_ID, '$weak_join'],
  }, '@target:example.org');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.4.5');
});

// 4.5 — leave (v11.md:190-202)

Deno.test('auth rule 4.5.1: self-leave from join/invite/knock is allowed', () => {
  // alice is joined: she may leave
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '@alice:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 4.5.1: self-leave from ban is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@bob:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    stateWithBannedBob(),
    storeWithBannedBob(),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.5.1');
});

Deno.test('auth rule 4.5.2: a kick from a non-joined sender is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@out:example.org',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.5.2');
});

// Unban footnote (v11.md:262-271): to unban somebody you must be >= kick
// AND >= ban AND > target.
Deno.test('auth rule unban: kick+ban levels and above the target allow the unban', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  // dev: 100 >= kick 50, >= ban 50, > bob 50? — no: 100 > 50 yes
  const v = checkAuthAgainstState(
    pdu,
    stateWithBannedBob(),
    storeWithBannedBob(),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule unban: below the ban level is rejected (4.5.3)', () => {
  // a level-30 unbanner (kick 50 satisfied? no — build PL with kick 20,
  // ban 60; sender 30: kick ok, ban not)
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: {
        '@dev:localhost': 100,
        '@mid:localhost': 30,
        '@bob:localhost': 10,
      },
      invite: 0,
      kick: 20,
      ban: 60,
    },
    event_id: '$pl_kb',
  }, '');
  const state = stateWithBannedBob();
  state.set(stateKeyOf('m.room.power_levels', ''), '$pl_kb');
  state.set(stateKeyOf('m.room.member', '@mid:localhost'), '$mid_join');
  const midJoin = mkPdu({
    type: 'm.room.member',
    sender: '@mid:localhost',
    content: { membership: 'join' },
    event_id: '$mid_join',
  }, '@mid:localhost');
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@mid:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, '$pl_kb', '$mid_join', JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    state,
    MemStore.from([...storeWithBannedBob().events.values(), pl, midJoin]),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.5.3');
});

Deno.test('auth rule unban: at/above both levels but not above the target is rejected (4.5.5)', () => {
  // sender level 50 == bob 50: kick+ban satisfied, target not below sender
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    stateWithBannedBob(),
    storeWithBannedBob(),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.5.5');
});

Deno.test('auth rule 4.5.4: a kick at/above the kick level over a lower target is allowed', () => {
  // dev (100) kicks bob (50, not banned)
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 4.5.5: a kick below the kick level or at/above the target is rejected', () => {
  // alice (50) kicks bob (50): target not below sender
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'leave' },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.5.5');
});

// 4.6 — ban (v11.md:203-209)

Deno.test('auth rule 4.6.1: a ban from a non-joined sender is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@out:example.org',
    content: { membership: 'ban' },
    auth_events: [CREATE_ID, PL_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.6.1');
});

Deno.test('auth rule 4.6.2: a ban at/above the ban level over a lower target is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID, JOIN_BOB_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 4.6.3: banning an equal-or-higher-power user is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'ban' },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID, JOIN_DEV_ID],
  }, '@dev:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.6.3');
});

// 4.7 — knock (v11.md:210-216)

function knockRoom(): { state: StateMap; store: MemStore } {
  const jr = mkPdu({
    type: 'm.room.join_rules',
    sender: '@dev:localhost',
    content: { join_rule: 'knock' },
    event_id: '$jr_knock',
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.join_rules', ''), '$jr_knock');
  return { state, store: MemStore.from([...genesisEvents(), jr]) };
}

Deno.test('auth rule 4.7.1: a knock against a non-knock join_rule is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@out:example.org',
    content: { membership: 'knock' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID],
  }, '@out:example.org');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.7.1');
});

Deno.test('auth rule 4.7.2: a knock whose sender differs from state_key is rejected', () => {
  const { state, store } = knockRoom();
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'knock' },
    auth_events: [CREATE_ID, PL_ID, '$jr_knock'],
  }, '@out:example.org');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.7.2');
});

Deno.test('auth rule 4.7.3: a knock from an unjoined sender is allowed', () => {
  const { state, store } = knockRoom();
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@out:example.org',
    content: { membership: 'knock' },
    auth_events: [CREATE_ID, PL_ID, '$jr_knock'],
  }, '@out:example.org');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, true);
});

Deno.test('auth rule 4.7.4: a knock from a joined/invited/banned sender is rejected', () => {
  const { state, store } = knockRoom();
  // alice is joined: re-knocking is rejected
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'knock' },
    auth_events: [CREATE_ID, PL_ID, '$jr_knock', JOIN_ALICE_ID],
  }, '@alice:localhost');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.7.4');
});

// 4.8 (v11.md:217)
Deno.test('auth rule 4.8: an unknown membership is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'professoring' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '@dev:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '4.8');
});

// --- rule 6 (v11.md:219-221) -----------------------------------------------

Deno.test('auth rule 6: third_party_invite at/above the invite level is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.third_party_invite',
    sender: '@alice:localhost',
    content: { public_key: 'k' },
    event_id: '$tpi_new',
  }, 'sometoken');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 6.1: third_party_invite below the invite level is rejected', () => {
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: { users: { '@dev:localhost': 100 }, users_default: 0, invite: 10 },
    event_id: '$pl10',
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.power_levels', ''), '$pl10');
  const store = MemStore.from([...genesisEvents(), pl]);
  const pdu = mkPdu({
    type: 'm.room.third_party_invite',
    sender: '@bob:localhost',
    content: { public_key: 'k' },
    event_id: '$tpi_new',
  }, 'sometoken');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '6.1');
});

// --- rule 7 (v11.md:222-223) -----------------------------------------------

Deno.test("auth rule 7: an event above the sender's required level is rejected", () => {
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: { '@dev:localhost': 100 },
      users_default: 0,
      events: { 'm.room.topic': 75 },
    },
    event_id: '$pl_topic75',
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.power_levels', ''), '$pl_topic75');
  const store = MemStore.from([...genesisEvents(), pl]);
  const pdu = mkPdu({
    type: 'm.room.topic',
    sender: '@alice:localhost',
    content: { topic: 'nope' },
    auth_events: [CREATE_ID, '$pl_topic75', JOIN_ALICE_ID],
  }, '');
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '7');
});

Deno.test('auth rule 7: an event at/above the required level passes the rule', () => {
  const pdu = mkPdu({
    type: 'm.room.topic',
    sender: '@alice:localhost',
    content: { topic: 'yep' },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '');
  // state_default 50, alice 50 -> 50 >= 50 passes
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

// --- rule 8 (v11.md:224-225) -----------------------------------------------

Deno.test('auth rule 8: a state_key starting with @ that differs from sender is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.account_data',
    sender: '@alice:localhost',
    content: {},
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '@bob:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '8');
});

Deno.test('auth rule 8: a state_key matching the sender passes the rule', () => {
  const pdu = mkPdu({
    type: 'm.room.account_data',
    sender: '@alice:localhost',
    content: {},
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '@alice:localhost');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

// --- rule 9 (v11.md:226-259) -----------------------------------------------

Deno.test('auth rule 9.1: a non-integer scalar is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      redact: 50,
      kick: 50,
      invite: 'zero',
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.1');
});

Deno.test('auth rule 9.2: non-integer events/notifications values are rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: { events: { 'm.room.topic': 'ten' } },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.2');
});

Deno.test('auth rule 9.3: users with invalid IDs or values are rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: { users: { 'no-sigil': 10 } },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.3');
});

Deno.test('auth rule 9.4: the first power_levels event is allowed by the delta rules', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: { '@dev:localhost': 100 },
      users_default: 0,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      state_default: 50,
      events_default: 0,
    },
    auth_events: [CREATE_ID, JOIN_DEV_ID],
  }, '');
  // state without a PL event
  const state = stateMapOf(
    put(CREATE_ID, 'm.room.create', ''),
    put(JOIN_DEV_ID, 'm.room.member', '@dev:localhost'),
  );
  const create = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11' },
    depth: 1,
    event_id: CREATE_ID,
  }, '');
  const joinDev = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'join' },
    event_id: JOIN_DEV_ID,
  }, '@dev:localhost');
  const v = checkAuthAgainstState(
    pdu,
    state,
    MemStore.from([create, joinDev]),
    V11,
  );
  assertEquals(v.ok, true);
});

Deno.test('auth rule 9.5.1: removing/raising a scalar above the sender level is rejected', () => {
  // genesis has state_default 50; dev is 100 -> must pass. Use @alice (50)
  // removing ban (50): 50 >= 50? 9.5.1 uses strictly higher — hmm, remove
  // by a low-power user who can send PLs at all: build PL state with
  // redact 99 and a 50-level sender.
  const plPrev = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      redact: 99,
      users_default: 0,
    },
    event_id: '$pl_prev',
  }, '');
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      users_default: 0,
    },
    auth_events: [CREATE_ID, '$pl_prev', JOIN_ALICE_ID],
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.power_levels', ''), '$pl_prev');
  const store = MemStore.from([
    ...genesisEvents().filter((e) => e.event_id !== PL_ID),
    plPrev,
  ]);
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.5.1');
});

Deno.test('auth rule 9.5.2: setting a scalar above the sender level is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      redact: 99,
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  // alice (50) sets redact 99 > 50; current redact 50 == sender 50 -> not 9.5.1
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.5.2');
});

Deno.test('auth rule 9.6.1: removing/raising an events entry above the sender level is rejected', () => {
  const plPrev = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      users_default: 0,
      events: { 'm.room.topic': 99 },
    },
    event_id: '$pl_prev',
  }, '');
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      users_default: 0,
      events: {},
    },
    auth_events: [CREATE_ID, '$pl_prev', JOIN_ALICE_ID],
  }, '');
  const state = genesisState();
  state.set(stateKeyOf('m.room.power_levels', ''), '$pl_prev');
  const store = MemStore.from([
    ...genesisEvents().filter((e) => e.event_id !== PL_ID),
    plPrev,
  ]);
  const v = checkAuthAgainstState(pdu, state, store, V11);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.6.1');
});

Deno.test('auth rule 9.7.1: adding an events entry above the sender level is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      events: { 'm.room.topic': 99 },
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.7.1');
});

Deno.test('auth rule 9.8.1: changing/removing another user at/above the sender level is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: {
        '@dev:localhost': 100,
        '@alice:localhost': 50,
        '@bob:localhost': 0,
      },
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '');
  // demote dev (100 >= 50): 9.8.1
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.rule, '9.8.1');
});

Deno.test('auth rule 9.9.1: adding/raising a user above the sender level is rejected', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: {
        '@dev:localhost': 100,
        '@alice:localhost': 50,
        '@bob:localhost': 60,
      },
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '');
  // raise bob 50 -> 60 > 50 (bob is not above... current bob 50 == alice 50:
  // 9.8.1 uses >= — but bob's change: current 50 >= 50 would fire 9.8.1
  // first! Order: 9.8 covers changed entries other than sender's own.
  // So a raise of an existing user hits 9.8.1 before 9.9.1 — use a NEW user.
  const pdu2 = mkPdu({
    type: 'm.room.power_levels',
    sender: '@alice:localhost',
    content: {
      users: {
        '@dev:localhost': 100,
        '@alice:localhost': 50,
        '@bob:localhost': 50,
        '@new:localhost': 60,
      },
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_ALICE_ID],
  }, '');
  const v2 = checkAuthAgainstState(
    pdu2,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v2.ok, false);
  if (!v2.ok) assertEquals(v2.rule, '9.9.1');
  void pdu;
});

Deno.test('auth rule 9.10: a compliant power_levels edit is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: {
        '@dev:localhost': 100,
        '@alice:localhost': 50,
        '@bob:localhost': 50,
      },
      users_default: 0,
      state_default: 50,
      events_default: 0,
      invite: 0,
      kick: 50,
      ban: 50,
      redact: 50,
    },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
  }, '');
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});

// --- rule 10 (v11.md:260) --------------------------------------------------

Deno.test('auth rule 10: an ordinary message from a joined member is allowed', () => {
  const pdu = mkPdu({
    type: 'm.room.message',
    sender: '@alice:localhost',
    content: { body: 'hello', msgtype: 'm.text' },
    auth_events: DEFAULT_AUTH,
  });
  const v = checkAuthAgainstState(
    pdu,
    genesisState(),
    MemStore.from(genesisEvents()),
    V11,
  );
  assertEquals(v.ok, true);
});
