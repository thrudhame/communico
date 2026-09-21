// tests/typing.test.ts — band C item 3: the TestTyping / TestLeakyTyping
// contract rows (plan §2, D1-D2, §3c-§3d; spec v1.16 typing.yaml +
// typing_notifications.md). Live doltgres, HTTP-level via the real
// endpoint trees.
import { assert, assertEquals } from '@std/assert';
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

function ephemeralOf(body: Json, roomId: string): Json[] {
  const rooms = ((body.rooms as Json)?.join ?? {}) as Json;
  return (((rooms[roomId] as Json)?.ephemeral as Json)?.events ?? []) as Json[];
}

Deno.test('typing: start/stop surfacing, no room_id, timeout 0 registers, no leaks, own-user only, token grammar', async () => {
  const alice = await registerTestUser('ty-a', 'pw-ty-a');
  const bob = await registerTestUser('ty-b', 'pw-ty-b');
  const carol = await registerTestUser('ty-c', 'pw-ty-c');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const cTok = carol.access_token!;
  const SN = serverName();

  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: { invite: [`@ty-b:${SN}`] },
  })).body.room_id as string;
  assertEquals(
    (await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      token: bTok,
      body: {},
    })).status,
    200,
  );
  const typingPath = `/_matrix/client/v3/rooms/${
    encodeURIComponent(roomId)
  }/typing/${encodeURIComponent(`@ty-a:${SN}`)}`;
  const putTyping = (body: unknown, tok = aTok, path = typingPath) =>
    call(path, { method: 'PUT', token: tok, body });

  // the sync token is five streams now (D1 + D10's account-data); a
  // legacy s<n> token parses
  assertEquals((await sync(bTok, '&since=s0')).status, 200);
  const t0 = (await sync(bTok)).body.next_batch as string;
  assert(/^s\d+_p\d+_t\d+_r\d+_a\d+$/.test(t0), t0);

  // typing start surfaces to room members with user_ids: [alice]
  assertEquals((await putTyping({ typing: true, timeout: 10000 })).status, 200);
  let since = t0;
  let res = await sync(bTok, `&since=${encodeURIComponent(since)}`);
  since = res.body.next_batch as string;
  let typingEvents = ephemeralOf(res.body, roomId).filter((e) =>
    e.type === 'm.typing'
  );
  assertEquals(typingEvents.length, 1);
  assertEquals(typingEvents[0].content as Json, {
    user_ids: [`@ty-a:${SN}`],
  });

  // explicit stop surfaces with user_ids: []
  assertEquals((await putTyping({ typing: false })).status, 200);
  res = await sync(bTok, `&since=${encodeURIComponent(since)}`);
  since = res.body.next_batch as string;
  typingEvents = ephemeralOf(res.body, roomId).filter((e) =>
    e.type === 'm.typing'
  );
  assertEquals(typingEvents.length, 1);
  assertEquals(typingEvents[0].content as Json, { user_ids: [] });

  // timeout: 0 still registers (the no-room_id case) — the event exists
  // and carries no room_id, whatever the sweep state of user_ids
  assertEquals((await putTyping({ typing: true, timeout: 0 })).status, 200);
  res = await sync(bTok, `&since=${encodeURIComponent(since)}`);
  since = res.body.next_batch as string;
  typingEvents = ephemeralOf(res.body, roomId).filter((e) =>
    e.type === 'm.typing'
  );
  assertEquals(typingEvents.length, 1);
  assertEquals('room_id' in typingEvents[0], false);

  // nothing new since → no typing event
  res = await sync(bTok, `&since=${encodeURIComponent(since)}`);
  assertEquals(
    ephemeralOf(res.body, roomId).some((e) => e.type === 'm.typing'),
    false,
  );

  // typing does not leak: carol (not in the room) sees nothing of it
  assertEquals((await putTyping({ typing: true, timeout: 10000 })).status, 200);
  const carolRes = await sync(cTok);
  const carolRooms = ((carolRes.body.rooms as Json)?.join ?? {}) as Json;
  assert(!(roomId in carolRooms), 'typing room must not reach a non-member');

  // own user only → 403 M_FORBIDDEN
  const forbidden = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${
      encodeURIComponent(`@ty-b:${SN}`)
    }`,
    { method: 'PUT', token: aTok, body: { typing: true, timeout: 1000 } },
  );
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.body.errcode, 'M_FORBIDDEN');
});
