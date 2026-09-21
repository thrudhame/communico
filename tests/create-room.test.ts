// tests/create-room.test.ts — §3c at the wire (plan §3g): presets, the
// spec-default power levels, override merge, initial_state vs name/topic
// ordering, invite list, room_alias_name, creation_content minus
// room_version, and the version validations. Live doltgres, HTTP-level
// via the real endpoint trees (the account.test.ts pattern).
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

async function stateKey(
  token: string,
  roomId: string,
  type: string,
  key = '',
): Promise<{ status: number; body: Json }> {
  return await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/state/${type}/${key}`,
    { token },
  );
}

Deno.test('createRoom: presets set join_rules/history_visibility/guest_access', async () => {
  const alice = await registerTestUser('cr-preset', 'pw-cr-preset');
  const tok = alice.access_token!;

  const pub = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { preset: 'public_chat' },
  });
  assertEquals(pub.status, 200);
  const pubId = pub.body.room_id as string;
  assertEquals((await stateKey(tok, pubId, 'm.room.join_rules')).body, {
    join_rule: 'public',
  });
  assertEquals((await stateKey(tok, pubId, 'm.room.history_visibility')).body, {
    history_visibility: 'shared',
  });
  assertEquals((await stateKey(tok, pubId, 'm.room.guest_access')).body, {
    guest_access: 'forbidden',
  });

  // default preset: visibility absent -> private_chat
  const priv = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {},
  });
  const privId = priv.body.room_id as string;
  assertEquals((await stateKey(tok, privId, 'm.room.join_rules')).body, {
    join_rule: 'invite',
  });
  assertEquals((await stateKey(tok, privId, 'm.room.guest_access')).body, {
    guest_access: 'can_join',
  });

  // visibility: public without a preset -> public_chat
  const vis = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { visibility: 'public' },
  });
  assertEquals(
    (await stateKey(tok, vis.body.room_id as string, 'm.room.join_rules'))
      .body,
    { join_rule: 'public' },
  );

  // unknown preset -> 400 M_INVALID_PARAM
  const bad = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { preset: 'nope' },
  });
  assertEquals(bad.status, 400);
  assertEquals(bad.body.errcode, 'M_INVALID_PARAM');
});

Deno.test('createRoom: spec-default power levels, every key explicit; override deep-merges', async () => {
  const alice = await registerTestUser('cr-pl', 'pw-cr-pl');
  const tok = alice.access_token!;
  const aliceId = `@cr-pl:${alice.home_server}`;

  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {},
  });
  const pl =
    (await stateKey(tok, res.body.room_id as string, 'm.room.power_levels'))
      .body;
  assertEquals(pl, {
    ban: 50,
    events: {},
    events_default: 0,
    invite: 0,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: { [aliceId]: 100 },
    users_default: 0,
    notifications: { room: 50 },
  });

  // override deep-merges over the defaults (TestDemotingUsersViaUsersDefault's shape)
  const bob = '@cr-pl-bob:' + alice.home_server;
  const res2 = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {
      preset: 'public_chat',
      power_level_content_override: {
        users_default: 100,
        users: { [aliceId]: 100, [bob]: 100 },
        events: {},
        notifications: {},
      },
    },
  });
  const pl2 =
    (await stateKey(tok, res2.body.room_id as string, 'm.room.power_levels'))
      .body;
  assertEquals(pl2, {
    ban: 50,
    events: {},
    events_default: 0,
    invite: 0,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: { [aliceId]: 100, [bob]: 100 },
    users_default: 100,
    notifications: { room: 50 },
  });

  // trusted_private_chat: every invite user gets users[u]=100
  const res3 = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { preset: 'trusted_private_chat', invite: [bob] },
  });
  const pl3 =
    (await stateKey(tok, res3.body.room_id as string, 'm.room.power_levels'))
      .body;
  assertEquals((pl3.users as Json)[bob], 100);
});

Deno.test('createRoom: initial_state, then name/topic override it (rich topic form)', async () => {
  const alice = await registerTestUser('cr-init', 'pw-cr-init');
  const tok = alice.access_token!;

  // initial_state alone: content verbatim (no m.topic added)
  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {
      initial_state: [
        { type: 'm.room.topic', state_key: '', content: { topic: 'Init' } },
      ],
      preset: 'public_chat',
    },
  });
  const topic =
    (await stateKey(tok, res.body.room_id as string, 'm.room.topic')).body;
  assertEquals(topic, { topic: 'Init' });

  // name + topic come after initial_state and override it
  const res2 = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {
      name: 'Real Name',
      topic: 'Test Room',
      initial_state: [
        {
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'Shenanigans' },
        },
        { type: 'm.room.name', state_key: '', content: { name: 'Init Name' } },
      ],
      preset: 'public_chat',
    },
  });
  const roomId = res2.body.room_id as string;
  assertEquals((await stateKey(tok, roomId, 'm.room.name')).body, {
    name: 'Real Name',
  });
  assertEquals((await stateKey(tok, roomId, 'm.room.topic')).body, {
    topic: 'Test Room',
    'm.topic': { 'm.text': [{ body: 'Test Room' }] },
  });
});

Deno.test('createRoom: invite list authors the invite member events', async () => {
  const alice = await registerTestUser('cr-inv', 'pw-cr-inv');
  const bob = await registerTestUser('cr-inv-b', 'pw-cr-inv-b');
  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: alice.access_token!,
    body: { invite: [bob.user_id] },
  });
  assertEquals(res.status, 200);
  const member = await stateKey(
    alice.access_token!,
    res.body.room_id as string,
    'm.room.member',
    bob.user_id,
  );
  assertEquals(member.status, 200);
  assertEquals((member.body as Json).membership, 'invite');
});

Deno.test('createRoom: room_alias_name registers the alias + canonical_alias; a repeat is 409', async () => {
  const alice = await registerTestUser('cr-alias', 'pw-cr-alias');
  const tok = alice.access_token!;
  const name = 'cr-alias-' +
    crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const alias = `#${name}:${alice.home_server}`;

  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_alias_name: name, visibility: 'public' },
  });
  assertEquals(res.status, 200);
  assertEquals(res.body.room_alias, alias);
  const ca = await stateKey(
    tok,
    res.body.room_id as string,
    'm.room.canonical_alias',
  );
  assertEquals(ca.body, { alias });

  const again = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_alias_name: name },
  });
  assertEquals(again.status, 409);
  assertEquals(again.body.errcode, 'M_ROOM_IN_USE');
});

Deno.test('createRoom: creation_content lands minus room_version; version validations', async () => {
  const alice = await registerTestUser('cr-ver', 'pw-cr-ver');
  const tok = alice.access_token!;

  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { creation_content: { test: 'azerty', room_version: 'test' } },
  });
  assertEquals(res.status, 200);
  const create = await stateKey(
    tok,
    res.body.room_id as string,
    'm.room.create',
  );
  assertEquals(create.body, { test: 'azerty', room_version: '11' });

  const numeric = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_version: 1 },
  });
  assertEquals(numeric.status, 400);
  assertEquals(numeric.body.errcode, 'M_BAD_JSON');

  const unknown = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_version: 'ahfgwjyerhgiuveisbruvybseyrugvi' },
  });
  assertEquals(unknown.status, 400);
  assertEquals(unknown.body.errcode, 'M_UNSUPPORTED_ROOM_VERSION');
});

Deno.test('createRoom: v10 writes content.creator; v12 omits it; capabilities list 3–12 with default 11', async () => {
  const alice = await registerTestUser('cr-v10', 'pw-cr-v10');
  const tok = alice.access_token!;
  const aId = alice.user_id as string;

  // v10: the create carries content.creator (v10.md:114)
  const v10 = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_version: '10' },
  });
  assertEquals(v10.status, 200);
  const create10 = await stateKey(
    tok,
    v10.body.room_id as string,
    'm.room.create',
  );
  assertEquals((create10.body as Json).creator, aId);
  assertEquals((create10.body as Json).room_version, '10');

  // v12: no creator key at all (v11+ derives the creator from the sender)
  const v12 = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_version: '12' },
  });
  assertEquals(v12.status, 200);
  const create12 = await stateKey(
    tok,
    v12.body.room_id as string,
    'm.room.create',
  );
  assertEquals('creator' in (create12.body as Json), false);
  assertEquals((create12.body as Json).room_version, '12');

  // /capabilities: registry-driven (D11) — 3–12 stable, default 11
  // (the older-versions plan, group A)
  const caps = await call('/_matrix/client/v3/capabilities', { token: tok });
  const rv = ((caps.body as Json).capabilities as Json)[
    'm.room_versions'
  ] as Json;
  assertEquals(rv.default, '11');
  assertEquals(rv.available, {
    '3': 'stable',
    '4': 'stable',
    '5': 'stable',
    '6': 'stable',
    '7': 'stable',
    '8': 'stable',
    '9': 'stable',
    '10': 'stable',
    '11': 'stable',
    '12': 'stable',
  });
});
