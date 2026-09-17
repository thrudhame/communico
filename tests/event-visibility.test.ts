// tests/event-visibility.test.ts — the B10 history-visibility table
// (plan §3g, apidoc_room_history_visibility_test.go's seven rows
// verbatim) and A4 (the LeftRoomFixture expectations — counts and bodies
// verbatim). Live doltgres, HTTP-level via the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
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

async function createWithVisibility(
  token: string,
  visibility: string,
): Promise<string> {
  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token,
    body: {
      preset: 'public_chat',
      initial_state: [
        {
          type: 'm.room.history_visibility',
          state_key: '',
          content: { history_visibility: visibility },
        },
      ],
    },
  });
  assertEquals(res.status, 200);
  return res.body.room_id as string;
}

async function sendText(
  token: string,
  roomId: string,
  body: string,
  txn: string,
): Promise<string> {
  const res = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/${txn}`,
    { method: 'PUT', token, body: { msgtype: 'm.text', body } },
  );
  assertEquals(res.status, 200);
  return res.body.event_id as string;
}

Deno.test('B10: the history_visibility table (7 rows)', async (t) => {
  const alice = await registerTestUser('b10-a', 'pw-b10-a');
  const bob = await registerTestUser('b10-b', 'pw-b10-b');
  const A = alice.access_token!;
  const B = bob.access_token!;
  const eventUrl = (roomId: string, eventId: string) =>
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${
      encodeURIComponent(eventId)
    }`;

  await t.step(
    'shared: a joined user fetches an event sent after the join (200)',
    async () => {
      const roomId = await createWithVisibility(A, 'shared');
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: B,
          body: {},
        },
      );
      const eventId = await sendText(A, roomId, 'Hello world', 'b10-1');
      const res = await call(eventUrl(roomId, eventId), { token: B });
      assertEquals(res.status, 200);
      assertEquals(res.body.content, {
        msgtype: 'm.text',
        body: 'Hello world',
      });
      assertEquals(res.body.type, 'm.room.message');
      assertEquals(res.body.room_id, roomId);
      assertEquals(res.body.sender, alice.user_id);
      assertEquals(res.body.event_id, eventId);
      assertEquals(typeof res.body.origin_server_ts, 'number');
    },
  );

  await t.step(
    'joined: an event from before the join is denied (404)',
    async () => {
      const roomId = await createWithVisibility(A, 'joined');
      const eventId = await sendText(A, roomId, 'Hello world', 'b10-2');
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: B,
          body: {},
        },
      );
      const res = await call(eventUrl(roomId, eventId), { token: B });
      assertEquals(res.status, 404);
    },
  );

  await t.step(
    'shared: an event from before the join is served (200)',
    async () => {
      const roomId = await createWithVisibility(A, 'shared');
      const eventId = await sendText(A, roomId, 'Hello world', 'b10-3');
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: B,
          body: {},
        },
      );
      const res = await call(eventUrl(roomId, eventId), { token: B });
      assertEquals(res.status, 200);
      assertEquals(res.body.content, {
        msgtype: 'm.text',
        body: 'Hello world',
      });
    },
  );

  await t.step(
    'invited: an event from between invite and join is served (200)',
    async () => {
      const roomId = await createWithVisibility(A, 'invited');
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
        {
          method: 'POST',
          token: A,
          body: { user_id: bob.user_id },
        },
      );
      const eventId = await sendText(A, roomId, 'Hello world', 'b10-4');
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: B,
          body: {},
        },
      );
      const res = await call(eventUrl(roomId, eventId), { token: B });
      assertEquals(res.status, 200);
    },
  );

  await t.step(
    'invited: an event from before the invite is denied (404)',
    async () => {
      const roomId = await createWithVisibility(A, 'invited');
      const eventId = await sendText(A, roomId, 'Hello world', 'b10-5');
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
        {
          method: 'POST',
          token: A,
          body: { user_id: bob.user_id },
        },
      );
      await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: B,
          body: {},
        },
      );
      const res = await call(eventUrl(roomId, eventId), { token: B });
      assertEquals(res.status, 404);
    },
  );

  await t.step('shared: a never-member is denied (404)', async () => {
    const roomId = await createWithVisibility(A, 'shared');
    const eventId = await sendText(A, roomId, 'Hello world', 'b10-6');
    const res = await call(eventUrl(roomId, eventId), { token: B });
    assertEquals(res.status, 404);
  });

  await t.step('world_readable: a never-member is served (200)', async () => {
    const roomId = await createWithVisibility(A, 'world_readable');
    const eventId = await sendText(A, roomId, 'Hello world', 'b10-7');
    const res = await call(eventUrl(roomId, eventId), { token: B });
    assertEquals(res.status, 200);
    assertEquals(res.body.content, { msgtype: 'm.text', body: 'Hello world' });
  });
});

Deno.test('A4: after leave, /state, /members and /messages reflect the leave point exactly', async () => {
  const alice = await registerTestUser('a4-a', 'pw-a4-a');
  const bob = await registerTestUser('a4-b', 'pw-a4-b');
  const charlie = await registerTestUser('a4-c', 'pw-a4-c');
  const A = alice.access_token!;
  const B = bob.access_token!;
  const C = charlie.access_token!;

  const roomId = await createWithVisibility(A, 'joined');
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    token: B,
    body: {},
  });

  const putState = async (
    type: string,
    content: Json,
  ) => {
    const res = await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`,
      { method: 'PUT', token: A, body: content },
    );
    assertEquals(res.status, 200);
  };
  await putState('m.room.name', { name: 'N1. before A left' });
  await putState('madeup.test.state', { body: 'S1. before A left' });
  await sendText(A, roomId, 'M1. before A left', 'a4-m1');
  await sendText(A, roomId, 'M2. before A left', 'a4-m2');

  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    token: B,
    body: {},
  });

  // bob's sync token (legacy s<n> from the current /sync — the position
  // after bob's leave; M4's /sync keeps the grammar)
  const syncRes = await call('/_matrix/client/v3/sync?timeout=0', { token: B });
  const bobSince = syncRes.body.next_batch as string;
  assert(typeof bobSince === 'string' && bobSince.startsWith('s'));

  await putState('m.room.name', { name: 'N2. after A left' });
  await putState('madeup.test.state', { body: 'S2. after A left' });
  await sendText(A, roomId, 'M3. after A left', 'a4-m3');
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    token: C,
    body: {},
  });

  const stateUrl = (type: string) =>
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`;

  // (1) bob gets the state as of the leave; alice gets the new state
  const bobMadeup = await call(stateUrl('madeup.test.state'), { token: B });
  assertEquals(bobMadeup.body, { body: 'S1. before A left' });
  const aliceMadeup = await call(stateUrl('madeup.test.state'), { token: A });
  assertEquals(aliceMadeup.body, { body: 'S2. after A left' });

  // (2) /members for the departed user: exactly alice|join + bob|leave
  const members = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
    { token: B },
  );
  assertEquals(members.status, 200);
  const mapped = (members.body.chunk as Json[])
    .map((e) => [e.type, e.state_key, (e.content as Json).membership].join('|'))
    .sort();
  assertEquals(mapped, [
    `m.room.member|${alice.user_id}|join`,
    `m.room.member|${bob.user_id}|leave`,
  ]);

  // (3) /messages dir=b limit=3 from the since token: the leave + the two
  // pre-leave messages, nothing else
  const msgs = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=3&from=${encodeURIComponent(bobSince)}`,
    { token: B },
  );
  assertEquals(msgs.status, 200);
  const msgMapped = (msgs.body.chunk as Json[])
    .map((e) =>
      [
        e.type,
        (e.content as Json).body ?? '',
        (e.state_key as string) ?? '',
      ].join('|')
    )
    .sort();
  assertEquals(msgMapped, [
    'm.room.member||' + bob.user_id,
    'm.room.message|M1. before A left|',
    'm.room.message|M2. before A left|',
  ]);

  "can get 'm.room.name' state for a departed room";
  // (4) bob gets the old name; alice gets the new one
  const bobName = await call(stateUrl('m.room.name'), { token: B });
  assertEquals(bobName.body, { name: 'N1. before A left' });
  const aliceName = await call(stateUrl('m.room.name'), { token: A });
  assertEquals(aliceName.body, { name: 'N2. after A left' });

  // (5) going forward from the leave point is empty
  const fwd = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=f&limit=100&from=${encodeURIComponent(bobSince)}`,
    { token: B },
  );
  assertEquals(fwd.status, 200);
  assertEquals(fwd.body.chunk, []);
});
