// tests/rulebook/legacy-versions.test.ts — the group A corpus (the
// older-versions plan): per version 3–9, the flag-driven behaviour —
// the aliases auth rule (3–5), the stringy power-levels grammar (≤9),
// `notifications` in the PL rules (6+), knock (7+), restricted (8+),
// and the per-version redaction tables. Spec tag v1.16; citations
// inline.
import { assertEquals } from '@std/assert';
import { checkAuthAgainstState } from '#engine/rulebook/auth-rules.ts';
import { parsePowerLevels } from '#engine/rulebook/power-levels.ts';
import {
  V10,
  V11,
  V12,
  V3,
  V4,
  V5,
  V6,
  V7,
  V8,
  V9,
} from '#engine/rulebook/index.ts';
import type { RoomVersionSpec } from '#engine/rulebook/types.ts';
import { redact } from '#engine/eventid.ts';
import {
  CREATE_ID,
  genesisEvents,
  genesisState,
  JOIN_DEV_ID,
  MemStore,
  mkPdu,
  PL_ID,
  put,
  restrictedState,
  restrictedStore,
  stateMapOf,
} from './fixtures.ts';

const DEV = '@dev:localhost';
const ALICE = '@alice:localhost';
const CAROL = '@carol:localhost';

const LEGACY: RoomVersionSpec[] = [V3, V4, V5, V6, V7, V8, V9];

// --- the aliases rule (v1–5 rule 4 — v1-auth-rules.md:44-47) -----------

Deno.test('legacy aliases rule: v3–v5 reject a missing state_key (4.1)', () => {
  for (const spec of [V3, V4, V5]) {
    const pdu = mkPdu({
      type: 'm.room.aliases',
      sender: DEV,
      content: { aliases: ['#r:localhost'] },
      auth_events: [CREATE_ID],
    });
    const v = checkAuthAgainstState(
      pdu,
      genesisState(),
      MemStore.from(genesisEvents()),
      spec,
    );
    assertEquals(v.ok, false, spec.identifier);
    if (!v.ok) assertEquals(v.rule, '4.1', spec.identifier);
  }
});

Deno.test('legacy aliases rule: v3–v5 reject a foreign state_key (4.2)', () => {
  for (const spec of [V3, V4, V5]) {
    const pdu = mkPdu({
      type: 'm.room.aliases',
      sender: DEV,
      content: { aliases: ['#r:example.org'] },
      auth_events: [CREATE_ID],
    }, 'example.org');
    const v = checkAuthAgainstState(
      pdu,
      genesisState(),
      MemStore.from(genesisEvents()),
      spec,
    );
    assertEquals(v.ok, false, spec.identifier);
    if (!v.ok) assertEquals(v.rule, '4.2', spec.identifier);
  }
});

Deno.test('legacy aliases rule: v3–v5 allow a matching state_key, terminal (4.3)', () => {
  for (const spec of [V3, V4, V5]) {
    // dev is NOT joined in this state — rule 5 would reject, proving the
    // aliases rule is terminal before it.
    const state = stateMapOf(put(CREATE_ID, 'm.room.create', ''));
    const store = MemStore.from(genesisEvents());
    const pdu = mkPdu({
      type: 'm.room.aliases',
      sender: DEV,
      content: { aliases: ['#r:localhost'] },
      auth_events: [CREATE_ID],
    }, 'localhost');
    const v = checkAuthAgainstState(pdu, state, store, spec);
    assertEquals(v.ok, true, spec.identifier);
    if (v.ok) assertEquals(v.rule, '4.3', spec.identifier);
  }
});

Deno.test('legacy aliases rule: v6+ treats m.room.aliases as ordinary state (v6.md:51-53)', () => {
  for (const spec of [V6, V7, V8, V9]) {
    const pdu = mkPdu({
      type: 'm.room.aliases',
      sender: DEV,
      content: { aliases: ['#r:localhost'] },
      auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
    }, 'localhost');
    const v = checkAuthAgainstState(
      pdu,
      genesisState(),
      MemStore.from(genesisEvents()),
      spec,
    );
    // dev (100) clears the state_default (50) — terminal allow
    assertEquals(v.ok, true, spec.identifier);
    if (v.ok) assertEquals(v.rule, '10', spec.identifier);
  }
});

// --- stringy power levels (≤9 — v1-stringy-power-levels.md:2-40) -------

const STRINGY_ACCEPT = [
  '100',
  '000100',
  '+100',
  '-100',
  ' 100 ',
  ' 00100 ',
  ' +100 ',
  ' -100 ',
];
const STRINGY_REJECT = ['abc', '10.5', '1e3', '', ' ', '+', '1 0', '0x10'];

Deno.test('legacy stringy PL: ≤9 accepts the grammar rows', () => {
  for (const spec of LEGACY) {
    for (const s of STRINGY_ACCEPT) {
      const r = parsePowerLevels({ users_default: s }, spec);
      assertEquals(
        r.ok,
        true,
        `${spec.identifier} accepts ${JSON.stringify(s)}`,
      );
    }
    for (const s of STRINGY_REJECT) {
      const r = parsePowerLevels({ users_default: s }, spec);
      assertEquals(
        r.ok,
        false,
        `${spec.identifier} rejects ${JSON.stringify(s)}`,
      );
    }
  }
});

Deno.test('legacy stringy PL: 10+ is integer-only (v10.md:67-74)', () => {
  const expect: [RoomVersionSpec, string][] = [
    [V10, '9.1'],
    [V11, '9.1'],
    [V12, '10.1'],
  ];
  for (const [spec, rule] of expect) {
    for (const s of STRINGY_ACCEPT) {
      const r = parsePowerLevels({ users_default: s }, spec);
      assertEquals(
        r.ok,
        false,
        `${spec.identifier} rejects ${JSON.stringify(s)}`,
      );
      if (!r.ok) assertEquals(r.rule, rule, spec.identifier);
    }
  }
});

Deno.test('legacy stringy PL: accepted strings parse to their integer', () => {
  const r = parsePowerLevels(
    {
      users: { [ALICE]: ' 050 ' },
      events: { 'm.room.message': '+0' },
      notifications: { room: '-1' },
      ban: '000100',
    },
    V3,
  );
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.pl.users[ALICE], 50);
    assertEquals(r.pl.events['m.room.message'], 0);
    assertEquals(r.pl.notifications['room'], -1);
    assertEquals(r.pl.ban, 100);
  }
});

// --- notifications in the PL rules (6+ — v6.md:55-58, 195-204) ---------

function notificationsDeltaState() {
  // alice (50) adds notifications.room=100 — above her level.
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: DEV,
    content: {
      users: { [DEV]: 100, [ALICE]: 50 },
      users_default: 0,
      state_default: 50,
      events_default: 0,
      invite: 0,
      kick: 50,
      ban: 50,
      redact: 50,
    },
    auth_events: [CREATE_ID, JOIN_DEV_ID],
    event_id: PL_ID,
  }, '');
  const events = genesisEvents().map((e) => e.event_id === PL_ID ? pl : e);
  return { events, state: genesisState() };
}

Deno.test('legacy notifications: ≤5 ignores the key in the PL rules', () => {
  const { events, state } = notificationsDeltaState();
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: ALICE,
    content: {
      users: { [DEV]: 100, [ALICE]: 50 },
      notifications: { room: 100 },
    },
    auth_events: [CREATE_ID, PL_ID],
  }, '');
  for (const spec of [V3, V4, V5]) {
    const v = checkAuthAgainstState(pdu, state, MemStore.from(events), spec);
    assertEquals(v.ok, true, spec.identifier);
    if (v.ok) assertEquals(v.rule, '10.8', spec.identifier);
  }
});

Deno.test('legacy notifications: 6+ compares entries like events', () => {
  const { events, state } = notificationsDeltaState();
  const pdu = mkPdu({
    type: 'm.room.power_levels',
    sender: ALICE,
    content: {
      users: { [DEV]: 100, [ALICE]: 50 },
      notifications: { room: 100 },
    },
    auth_events: [CREATE_ID, PL_ID],
  }, '');
  for (const spec of [V6, V7, V8, V9]) {
    const v = checkAuthAgainstState(pdu, state, MemStore.from(events), spec);
    assertEquals(v.ok, false, spec.identifier);
    if (!v.ok) assertEquals(v.rule, '9.5.1', spec.identifier);
  }
});

// --- knock (7+ — v7.md:155-161) -----------------------------------------

function knockState() {
  const jr = mkPdu({
    type: 'm.room.join_rules',
    sender: DEV,
    content: { join_rule: 'knock' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
    event_id: '$jr_knock',
  }, '');
  const state = genesisState();
  state.set('m.room.join_rules\0', '$jr_knock');
  return { events: [...genesisEvents(), jr], state };
}

Deno.test('legacy knock: ≤6 rejects a knock membership', () => {
  const { events, state } = knockState();
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: CAROL,
    content: { membership: 'knock' },
    auth_events: [CREATE_ID, PL_ID],
  }, CAROL);
  for (const spec of [V3, V4, V5, V6]) {
    const v = checkAuthAgainstState(pdu, state, MemStore.from(events), spec);
    assertEquals(v.ok, false, spec.identifier);
  }
});

Deno.test('legacy knock: 7+ allows a knock (4.6.3 / 4.7.3)', () => {
  const { events, state } = knockState();
  const pdu = mkPdu({
    type: 'm.room.member',
    sender: CAROL,
    content: { membership: 'knock' },
    auth_events: [CREATE_ID, PL_ID],
  }, CAROL);
  const expect: [RoomVersionSpec, string][] = [
    [V7, '4.6.3'],
    [V8, '4.7.3'],
    [V9, '4.7.3'],
  ];
  for (const [spec, rule] of expect) {
    const v = checkAuthAgainstState(pdu, state, MemStore.from(events), spec);
    assertEquals(v.ok, true, spec.identifier);
    if (v.ok) assertEquals(v.rule, rule, spec.identifier);
  }
});

// --- restricted (8+ — v8-auth-rules.md:72-78) ----------------------------

function restrictedJoin() {
  return mkPdu({
    type: 'm.room.member',
    sender: CAROL,
    content: {
      membership: 'join',
      join_authorised_via_users_server: DEV,
    },
    auth_events: [CREATE_ID, PL_ID],
    signatures: { localhost: { 'ed25519:k': 'sig' } },
  }, CAROL);
}

Deno.test('legacy restricted: ≤7 rejects a restricted join', () => {
  for (const spec of [V3, V4, V5, V6, V7]) {
    const v = checkAuthAgainstState(
      restrictedJoin(),
      restrictedState(),
      restrictedStore(),
      spec,
    );
    assertEquals(v.ok, false, spec.identifier);
  }
});

Deno.test('legacy restricted: 8+ allows via an authorising user (4.3.5.3)', () => {
  for (const spec of [V8, V9]) {
    const v = checkAuthAgainstState(
      restrictedJoin(),
      restrictedState(),
      restrictedStore(),
      spec,
    );
    assertEquals(v.ok, true, spec.identifier);
    if (v.ok) assertEquals(v.rule, '4.3.5.3', spec.identifier);
  }
});

// --- redaction tables (plan D6) ------------------------------------------

const FAT_CONTENT = {
  membership: 'join',
  join_authorised_via_users_server: DEV,
  third_party_invite: { signed: { token: 't' }, junk: 1 },
  creator: DEV,
  room_version: '3',
  join_rule: 'restricted',
  allow: [{ type: 'm.room.membership', room_id: '!o:localhost' }],
  aliases: ['#r:localhost'],
  ban: 50,
  events: { 'm.room.message': 0 },
  events_default: 0,
  invite: 0,
  kick: 50,
  redact: 50,
  state_default: 50,
  users: { [DEV]: 100 },
  users_default: 0,
  notifications: { room: 50 },
  history_visibility: 'shared',
  redacts: '$target',
  reason: 'spam',
  junk: 1,
};

function fatEvent(type: string): Record<string, unknown> {
  return {
    event_id: '$e',
    type,
    room_id: '!r:localhost',
    sender: DEV,
    state_key: '',
    content: { ...FAT_CONTENT },
    hashes: { sha256: 'h' },
    signatures: {},
    depth: 2,
    prev_events: ['$p'],
    prev_state: [],
    auth_events: ['$a'],
    origin: 'localhost',
    origin_server_ts: 1,
    membership: 'join',
    redacts: '$target',
    unsigned: { age: 1 },
  };
}

Deno.test('legacy redactions: member content per table', () => {
  const ev = fatEvent('m.room.member');
  // v1/v6/v8: membership only (the j_a_v_u_s keep is the v9 fix —
  // v9.md:21-23).
  for (const v of ['3', '6', '8']) {
    assertEquals(redact(ev, v).content, { membership: 'join' }, v);
  }
  assertEquals(redact(ev, '9').content, {
    membership: 'join',
    join_authorised_via_users_server: DEV,
  });
  assertEquals(redact(ev, '11').content, {
    membership: 'join',
    join_authorised_via_users_server: DEV,
    third_party_invite: { signed: { token: 't' } },
  });
});

Deno.test('legacy redactions: create keeps creator only ≤10, all keys in v11', () => {
  const ev = fatEvent('m.room.create');
  for (const v of ['3', '6', '8', '9']) {
    assertEquals(redact(ev, v).content, { creator: DEV }, v);
  }
  assertEquals(redact(ev, '11').content, FAT_CONTENT);
});

Deno.test('legacy redactions: join_rules allow survives from v8 (v8.md:66)', () => {
  const ev = fatEvent('m.room.join_rules');
  for (const v of ['3', '6']) {
    assertEquals(redact(ev, v).content, { join_rule: 'restricted' }, v);
  }
  for (const v of ['8', '9', '11']) {
    assertEquals(
      redact(ev, v).content,
      { join_rule: 'restricted', allow: FAT_CONTENT.allow },
      v,
    );
  }
});

Deno.test('legacy redactions: PL keeps 8 keys ≤10 (no invite), 9 in v11', () => {
  const ev = fatEvent('m.room.power_levels');
  const legacy = {
    ban: 50,
    events: { 'm.room.message': 0 },
    events_default: 0,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: { [DEV]: 100 },
    users_default: 0,
  };
  for (const v of ['3', '6', '8', '9']) {
    assertEquals(redact(ev, v).content, legacy, v);
  }
  assertEquals(redact(ev, '11').content, { ...legacy, invite: 0 });
});

Deno.test('legacy redactions: aliases content kept in v1 only (v1-redactions.md:30)', () => {
  const ev = fatEvent('m.room.aliases');
  assertEquals(redact(ev, '3').content, { aliases: ['#r:localhost'] });
  for (const v of ['6', '8', '9', '11']) {
    assertEquals(redact(ev, v).content, {}, v);
  }
});

Deno.test('legacy redactions: redaction events — content redacts v11 only; top-level redacts never kept', () => {
  const ev = fatEvent('m.room.redaction');
  for (const v of ['3', '6', '8', '9']) {
    const r = redact(ev, v);
    assertEquals(r.content, {}, v);
    // the top-level redacts is NOT in the 15-key keep list
    // (v1-redactions.md:5-19) — stripped on redaction.
    assertEquals('redacts' in r, false, v);
  }
  const r11 = redact(ev, '11');
  assertEquals(r11.content, { redacts: '$target' });
  assertEquals('redacts' in r11, false);
});

Deno.test('legacy redactions: top-level prev_state/origin/membership kept ≤10, stripped in v11', () => {
  const ev = fatEvent('m.room.message');
  for (const v of ['3', '6', '8', '9']) {
    const r = redact(ev, v);
    assertEquals(r.prev_state, [], v);
    assertEquals(r.origin, 'localhost', v);
    assertEquals(r.membership, 'join', v);
  }
  const r11 = redact(ev, '11');
  assertEquals('prev_state' in r11, false);
  assertEquals('origin' in r11, false);
  assertEquals('membership' in r11, false);
});
