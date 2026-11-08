// tests/rulebook/power-levels.test.ts — S5 defaults, creator-100, S6 integer
// enforcement, requiredLevel precedence. Pure: no DB, hand-built Pdu shapes.
// Citations (spec tag v1.16):
// - defaults / creator-100: data/event-schemas/schema/m.room.power_levels.yaml
//   10-14 (users -> users_default -> 0; no PL event -> creator 100, others 0),
//   23-26 (state_default 50 / events_default 0), 28-33 (kick/ban/redact 50,
//   invite 0)
// - integer-only (v10+): content/rooms/v10.md 67-74, 221-228
// - required level: content/server-server-api.md 489-495 (Definitions:
//   "Required Power Level")
import { assertEquals } from '@std/assert';
import {
  namedLevel,
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from '#engine/rulebook/power-levels.ts';
import { V11 } from '#engine/rulebook/room-versions.ts';
import type { Pdu } from '#engine/rulebook/types.ts';

function pl(content: Record<string, unknown>): Pdu {
  return {
    type: 'm.room.power_levels',
    room_id: '!r:localhost',
    sender: '@dev:localhost',
    content,
    state_key: '',
    prev_events: [],
    auth_events: [],
    depth: 2,
    origin_server_ts: 0,
    hashes: { sha256: '' },
    signatures: {},
  };
}

const create = (): Pdu => ({
  type: 'm.room.create',
  room_id: '!r:localhost',
  sender: '@dev:localhost',
  content: { room_version: '11' },
  state_key: '',
  prev_events: [],
  auth_events: [],
  depth: 1,
  origin_server_ts: 0,
  hashes: { sha256: '' },
  signatures: {},
});

// --- S5: userPowerLevel precedence: users[u] -> users_default -> 0 -------

Deno.test('power-levels: users[u] beats users_default beats 0 (schema 10-12)', () => {
  const ev = pl({
    users: { '@alice:localhost': 75 },
    users_default: 25,
  });
  assertEquals(userPowerLevel('@alice:localhost', ev, null, V11), 75);
  assertEquals(userPowerLevel('@bob:localhost', ev, null, V11), 25);
  // users_default absent -> 0 (schema 11-12: "If `users_default` is not
  // supplied, it is assumed to be 0")
  assertEquals(
    userPowerLevel('@bob:localhost', pl({ users: {} }), null, V11),
    0,
  );
});

Deno.test('power-levels: no PL event -> creator 100, others 0 (schema 13-14, 99-101)', () => {
  // creator == create.sender -> 100
  assertEquals(userPowerLevel('@dev:localhost', null, create(), V11), 100);
  // everyone else -> 0
  assertEquals(userPowerLevel('@bob:localhost', null, create(), V11), 0);
  // no PL event and no create event -> 0 (no creator to infer)
  assertEquals(userPowerLevel('@dev:localhost', null, null, V11), 0);
});

Deno.test('power-levels: with a PL event the creator-100 rule no longer applies (schema 99-101)', () => {
  // the creator-100 rule is "when there is no m.room.power_levels event";
  // once one exists the creator reads like anyone else (users -> users_default -> 0)
  const ev = pl({ users_default: 0 });
  assertEquals(userPowerLevel('@dev:localhost', ev, create(), V11), 0);
});

// --- S6: integer-only power levels (v10.md 67-74, 221-228) ---------------

Deno.test('power-levels: strings are rejected, never coerced (v10 72-74)', () => {
  const bad = parsePowerLevels({ users_default: '50' }, V11);
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.rule, '9.1');
});

Deno.test('power-levels: non-integral numbers are rejected (v10 72-74)', () => {
  const bad = parsePowerLevels({ ban: 50.5 }, V11);
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.rule, '9.1');
});

// Note on `50.0`: JSON parses `50.0` and `50` to the same JS number, and
// canonical JSON serializes both as `50` — a parsed 50.0 is literally
// indistinguishable from 50 and IS an integer under the schema (the v10
// rule targets strings / structurally-wrong values: v10.md 72-74). The
// distinguishable rejects are the two cases above.

Deno.test('power-levels: plain integers pass', () => {
  const good = parsePowerLevels(
    {
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      redact: 50,
      kick: 50,
      invite: 0,
      users: { '@dev:localhost': 100 },
      events: { 'm.room.topic': 25 },
      notifications: { room: 50 },
    },
    V11,
  );
  assertEquals(good.ok, true);
});

Deno.test('power-levels: non-integer inside users/events/notifications rejected (9.2, 9.3)', () => {
  const ev = parsePowerLevels({ events: { 'm.room.topic': '25' } }, V11);
  assertEquals(ev.ok, false);
  if (!ev.ok) assertEquals(ev.rule, '9.2');
  const notif = parsePowerLevels({ notifications: { room: 1.5 } }, V11);
  assertEquals(notif.ok, false);
  if (!notif.ok) assertEquals(notif.rule, '9.2');
  const users = parsePowerLevels({ users: { 'not-a-user': 50 } }, V11);
  assertEquals(users.ok, false);
  if (!users.ok) assertEquals(users.rule, '9.3');
  const usersBadVal = parsePowerLevels(
    { users: { '@dev:localhost': '50' } },
    V11,
  );
  assertEquals(usersBadVal.ok, false);
  if (!usersBadVal.ok) assertEquals(usersBadVal.rule, '9.3');
});

Deno.test('power-levels: users keys must be valid user IDs (appendices 561-567)', () => {
  assertEquals(
    parsePowerLevels({ users: { '@ok:localhost': 0 } }, V11).ok,
    true,
  );
  assertEquals(
    parsePowerLevels({ users: { '@UPPER:localhost': 0 } }, V11).ok,
    false,
  );
  assertEquals(
    parsePowerLevels({ users: { '@:localhost': 0 } }, V11).ok,
    false,
  );
  assertEquals(
    parsePowerLevels({ users: { 'no-sigil:localhost': 0 } }, V11).ok,
    false,
  );
  assertEquals(
    parsePowerLevels({ users: { '@bad*char:localhost': 0 } }, V11).ok,
    false,
  );
});

// --- requiredLevel (server-server-api.md 489-495) -------------------------

Deno.test('power-levels: requiredLevel — events[type] beats state_default/events_default', () => {
  const p = parsePowerLevels(
    {
      events: { 'm.room.topic': 25 },
      state_default: 60,
      events_default: 10,
    },
    V11,
  );
  assertEquals(p.ok, true);
  if (!p.ok) return;
  const parsed = p.pl;
  // listed explicitly in `events` -> that level
  assertEquals(requiredLevel('m.room.topic', '', parsed), 25);
  // not listed: state event -> state_default
  assertEquals(requiredLevel('m.room.other_state', '', parsed), 60);
  // not listed: message event (no state_key) -> events_default
  assertEquals(requiredLevel('m.room.message', undefined, parsed), 10);
});

Deno.test('power-levels: defaults when the property or event is missing (schema 23-26)', () => {
  // no PL event at all: state_default 50, events_default 0
  assertEquals(requiredLevel('m.room.topic', '', null), 50);
  assertEquals(requiredLevel('m.room.message', undefined, null), 0);
  // PL event without the keys: same defaults
  const p = parsePowerLevels({ users: { '@dev:localhost': 100 } }, V11);
  assertEquals(p.ok, true);
  if (!p.ok) return;
  assertEquals(requiredLevel('m.room.topic', '', p.pl), 50);
  assertEquals(requiredLevel('m.room.message', undefined, p.pl), 0);
});

// --- named levels (schema 28-33; server-server-api.md 497-502) ------------

Deno.test('power-levels: named levels default invite 0, kick/ban/redact 50', () => {
  const empty = parsePowerLevels({}, V11);
  assertEquals(empty.ok, true);
  if (!empty.ok) return;
  assertEquals(namedLevel('invite', empty.pl), 0);
  assertEquals(namedLevel('kick', empty.pl), 50);
  assertEquals(namedLevel('ban', empty.pl), 50);
  assertEquals(namedLevel('redact', empty.pl), 50);
  const set = parsePowerLevels(
    { invite: 5, kick: 25, ban: 60, redact: 99 },
    V11,
  );
  assertEquals(set.ok, true);
  if (!set.ok) return;
  assertEquals(namedLevel('invite', set.pl), 5);
  assertEquals(namedLevel('kick', set.pl), 25);
  assertEquals(namedLevel('ban', set.pl), 60);
  assertEquals(namedLevel('redact', set.pl), 99);
});
