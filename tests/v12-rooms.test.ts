// tests/v12-rooms.test.ts — v12 rooms end to end (plan §2): the room id
// is the create event's id; PL defaults (users {}, tombstone 150);
// creator power (kicks any finite admin, can't be kicked); rule 10.4 →
// 400; trusted_private_chat → additional_creators; room_id on the create
// event for every C-S read except /sync (D2). Live doltgres, HTTP-level
// via the real endpoint trees.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
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

const sync = (token: string, query = '') =>
  call(`/_matrix/client/v3/sync?timeout=0${query}`, { token });

const MAX_INT = 9007199254740991; // 2^53-1

Deno.test('v12 rooms: derived room id, PL defaults, creator power, 10.4 → 400, additional_creators, room_id on C-S reads', async () => {
  const alice = await registerTestUser('v12-a', 'pw-v12-a');
  const bob = await registerTestUser('v12-b', 'pw-v12-b');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const aId = alice.user_id as string;
  const bId = bob.user_id as string;

  const mk = async (body: unknown, tok = aTok) => {
    const res = await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: tok,
      body,
    });
    return res;
  };
  const stateEvent = (roomId: string, type: string, key = '') =>
    call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/state/${type}/${key}`,
      { token: aTok },
    );
  const putState = (
    roomId: string,
    type: string,
    content: unknown,
    tok = aTok,
  ) =>
    call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}`,
      { method: 'PUT', token: tok, body: content },
    );

  // --- room id = '!' + create event id; PL defaults ------------------------
  const roomId = (await mk({ room_version: '12' })).body.room_id as string;
  // /state/:type returns the CONTENT by default; format=event returns the event
  const createFull = (
    await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/state/m.room.create?format=event`,
      { token: aTok },
    )
  ).body;
  const createId = createFull.event_id as string;
  assertEquals(roomId, '!' + createId.slice(1));
  // the create event carries room_id on C-S reads (D2)
  assertEquals(createFull.room_id, roomId);

  const pl = (await stateEvent(roomId, 'm.room.power_levels')).body;
  assertEquals(pl.users, {});
  assertEquals((pl.events as Json)['m.room.tombstone'], 150);

  // /state (whole) and /messages carry room_id on the create; /sync does not
  const wholeState = (await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
    { token: aTok },
  )).body as unknown as Json[];
  const createInState = wholeState.find((e) => e.type === 'm.room.create')!;
  assertEquals(createInState.room_id, roomId);
  const msgs = (await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=100`,
    { token: aTok },
  )).body;
  const createInMsgs = (msgs.chunk as Json[]).find((e) =>
    e.type === 'm.room.create'
  )!;
  assertEquals(createInMsgs.room_id, roomId);
  // /event/{id} too
  const byId = (await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${
      encodeURIComponent(createId)
    }`,
    { token: aTok },
  )).body;
  assertEquals(byId.room_id, roomId);
  // /sync: NO room_id on any event (sync.yaml's ClientEventWithoutRoomID)
  const syncRes = await sync(aTok);
  const timeline =
    ((((syncRes.body.rooms as Json).join as Json)[roomId] as Json)
      ?.timeline as Json)?.events as Json[];
  for (const e of timeline) {
    assertEquals('room_id' in e, false, e.type as string);
  }

  // --- creator power: kicks any finite admin; cannot be kicked --------------
  const room2 = (await mk({ room_version: '12', invite: [bId] })).body
    .room_id as string;
  assertEquals(
    (await call(`/_matrix/client/v3/rooms/${encodeURIComponent(room2)}/join`, {
      method: 'POST',
      token: bTok,
      body: {},
    })).status,
    200,
  );
  // admin at the canonical max
  assertEquals(
    (await putState(room2, 'm.room.power_levels', {
      users: { [bId]: MAX_INT },
    })).status,
    200,
  );
  // beyond the canonical max → 400 (band C canonical-number rule)
  assertEquals(
    (await putState(room2, 'm.room.power_levels', {
      users: { [bId]: MAX_INT + 1 },
    })).status,
    400,
  );
  // creator kicks the max-int admin
  assertEquals(
    (await call(`/_matrix/client/v3/rooms/${encodeURIComponent(room2)}/kick`, {
      method: 'POST',
      token: aTok,
      body: { user_id: bId },
    })).status,
    200,
  );
  // and the max-int admin cannot kick the creator
  const room3 = (await mk({ room_version: '12', invite: [bId] })).body
    .room_id as string;
  assertEquals(
    (await call(`/_matrix/client/v3/rooms/${encodeURIComponent(room3)}/join`, {
      method: 'POST',
      token: bTok,
      body: {},
    })).status,
    200,
  );
  assertEquals(
    (await putState(room3, 'm.room.power_levels', {
      users: { [bId]: MAX_INT },
    })).status,
    200,
  );
  const kickBack = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room3)}/kick`,
    { method: 'POST', token: bTok, body: { user_id: aId } },
  );
  assertEquals(kickBack.status, 403);
  assertEquals(kickBack.body.errcode, 'M_FORBIDDEN');

  // --- rule 10.4 → 400 (state PUT and createRoom override) -------------------
  assertEquals(
    (await putState(room3, 'm.room.power_levels', {
      users: { [aId]: 100 },
    })).status,
    400,
  );
  // the override form can set a non-creator…
  const okOverride = await mk({
    room_version: '12',
    power_level_content_override: { users: { [bId]: 100 } },
  });
  assertEquals(okOverride.status, 200);
  // …but not the creator
  const badOverride = await mk({
    room_version: '12',
    power_level_content_override: { users: { [aId]: 100 } },
  });
  assertEquals(badOverride.status, 400);

  // --- additional_creators: validation + trusted_private_chat ----------------
  for (
    const value of [
      'not-an-array',
      ['@foo:example.com', 42],
      ['@foo:example.com', 'not-a-user-id'],
      ['@invalid:dom$ain$.com'],
    ]
  ) {
    const res = await mk({
      room_version: '12',
      creation_content: { additional_creators: value },
    });
    assertEquals(res.status, 400, JSON.stringify(value));
  }
  const valid = await mk({
    room_version: '12',
    creation_content: {
      additional_creators: ['@foo:example.com', '@bar:baz.code'],
    },
  });
  assertEquals(valid.status, 200);
  const validCreate = (await stateEvent(
    valid.body.room_id as string,
    'm.room.create',
  )).body;
  assertEquals(validCreate.additional_creators, [
    '@foo:example.com',
    '@bar:baz.code',
  ]);
  // trusted_private_chat appends the invitees, deduplicated
  const trusted = await mk({
    room_version: '12',
    preset: 'trusted_private_chat',
    invite: [bId],
    creation_content: { additional_creators: [bId] },
  });
  assertEquals(trusted.status, 200);
  const trustedCreate = (await stateEvent(
    trusted.body.room_id as string,
    'm.room.create',
  )).body;
  assertEquals(trustedCreate.additional_creators, [bId]);
  // and the invitees are NOT in PL users (rule 10.4's complement)
  const trustedPl = (await stateEvent(
    trusted.body.room_id as string,
    'm.room.power_levels',
  )).body;
  assertEquals(trustedPl.users, {});

  // --- m.room.create cannot be PUT after creation -----------------------------
  const createPut = await putState(roomId, 'm.room.create', {
    room_version: '12',
    entropy: 100,
  });
  assertEquals(createPut.status, 400);

  // --- two v12 rooms get distinct ids; v11 rooms keep the minted shape --------
  const second = (await mk({ room_version: '12' })).body.room_id as string;
  assertNotEquals(roomId, second);
  const v11 = (await mk({})).body.room_id as string;
  assert(v11.endsWith(':' + serverName()), v11);
});
