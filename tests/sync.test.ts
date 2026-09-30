// tests/sync.test.ts — the per-user /sync (plan §3g): the C-section
// assertions driven over HTTP via the real endpoint trees. Live
// doltgres.
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

const sync = (token: string, query = '') =>
  call(`/_matrix/client/v3/sync?timeout=0${query}`, { token });

async function createRoom(token: string, body: Json = {}): Promise<string> {
  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token,
    body,
  });
  assertEquals(res.status, 200);
  return res.body.room_id as string;
}

async function sendText(
  token: string,
  roomId: string,
  body: string,
  txn: string,
): Promise<void> {
  const res = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/${txn}`,
    { method: 'PUT', token, body: { msgtype: 'm.text', body } },
  );
  assertEquals(res.status, 200);
}

Deno.test('sync: an unchanged room is absent in incremental syncs', async () => {
  const alice = await registerTestUser('sy-a', 'pw-sy-a');
  const tok = alice.access_token!;
  const roomId = await createRoom(tok);

  const initial = await sync(tok);
  assert((initial.body.rooms as Json).join as Json);
  const since = initial.body.next_batch as string;

  const incremental = await sync(tok, `&since=${encodeURIComponent(since)}`);
  const join = (incremental.body.rooms as Json).join as Json;
  assertEquals(join[roomId] === undefined, true, 'unchanged room present');

  await sendText(tok, roomId, 'ping', 'sy-1');
  const after = await sync(tok, `&since=${encodeURIComponent(since)}`);
  const join2 = (after.body.rooms as Json).join as Json;
  assert(join2[roomId] !== undefined, 'changed room absent');
});

Deno.test('sync: leave section — incremental regardless of filter; initial only with include_leave', async () => {
  const alice = await registerTestUser('sy-b', 'pw-sy-b');
  const tok = alice.access_token!;
  const roomId = await createRoom(tok);

  const before = (await sync(tok)).body.next_batch as string;
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    token: tok,
    body: {},
  });

  // incremental, no filter: the leave is in the window -> present
  const inc = await sync(tok, `&since=${encodeURIComponent(before)}`);
  const incLeave = (inc.body.rooms as Json).leave as Json;
  assert(incLeave[roomId] !== undefined, 'leave room absent in incremental');

  // initial without include_leave -> absent
  const initial = await sync(tok);
  const initLeave = (initial.body.rooms as Json).leave as Json;
  assertEquals(initLeave[roomId] === undefined, true);

  // initial with include_leave -> present
  const withLeave = await sync(
    tok,
    `&filter=${encodeURIComponent('{"room":{"include_leave":true}}')}`,
  );
  const wlLeave = (withLeave.body.rooms as Json).leave as Json;
  assert(wlLeave[roomId] !== undefined, 'leave room absent with include_leave');
});

Deno.test('sync: limited/prev_batch with timeline.limit (B1 ruling); prev_batch usable as /members?at=', async () => {
  const alice = await registerTestUser('sy-c', 'pw-sy-c');
  const bob = await registerTestUser('sy-c-b', 'pw-sy-c-b');
  const tok = alice.access_token!;

  // trimmed: 15 messages, limit 10
  const big = await createRoom(tok);
  for (let n = 0; n < 15; n++) await sendText(tok, big, `m${n}`, `sy-c-${n}`);
  const filter = encodeURIComponent('{"room":{"timeline":{"limit":10}}}');
  const res = await sync(tok, `&filter=${filter}`);
  const timeline = ((res.body.rooms as Json).join as Json)[big] as Json;
  const tl = timeline.timeline as Json;
  assertEquals((tl.events as Json[]).length, 10);
  assertEquals(tl.limited, true);
  const prevBatch = tl.prev_batch as string;
  assert(
    prevBatch !== res.body.next_batch,
    'a trimmed timeline keeps prev_batch at the window start',
  );

  // untrimmed: a fresh room's whole history fits -> prev_batch = window end
  const small = await createRoom(tok);
  const res2 = await sync(tok);
  const tl2 = (((res2.body.rooms as Json).join as Json)[small] as Json)
    .timeline as Json;
  assertEquals(tl2.limited, false);
  assertEquals(
    tl2.prev_batch,
    res2.body.next_batch,
    'untrimmed: prev_batch is the window end (B1)',
  );

  // prev_batch is usable as /members?at= (TestGetRoomMembersAtPoint's
  // shape): a public room, a message, a sync; bob joins after; members
  // at the prev_batch are exactly [alice]
  const pub = await createRoom(tok, { preset: 'public_chat' });
  await sendText(tok, pub, 'hello', 'sy-c-pub');
  const res4 = await sync(tok);
  const pb4 = ((((res4.body.rooms as Json).join as Json)[pub] as Json)
    .timeline as Json).prev_batch as string;
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(pub)}/join`, {
    method: 'POST',
    token: bob.access_token!,
    body: {},
  });
  const members = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(pub)}/members?at=${
      encodeURIComponent(pb4)
    }`,
    { token: alice.access_token! },
  );
  assertEquals(members.status, 200);
  const who = (members.body.chunk as Json[])
    .map((e) => `${e.state_key}`)
    .sort();
  assertEquals(who, [alice.user_id]);
});

Deno.test('sync: types filter restricts the timeline', async () => {
  const alice = await registerTestUser('sy-d', 'pw-sy-d');
  const tok = alice.access_token!;
  const roomId = await createRoom(tok);
  await sendText(tok, roomId, 'only message', 'sy-d-1');
  const filter = encodeURIComponent(
    '{"room":{"timeline":{"types":["m.room.message"]}}}',
  );
  const res = await sync(tok, `&filter=${filter}`);
  const tl = (((res.body.rooms as Json).join as Json)[roomId] as Json)
    .timeline as Json;
  const types = (tl.events as Json[]).map((e) => e.type);
  assertEquals(types, ['m.room.message']);
});

Deno.test('sync: a token is a global stream position — reusable by another user', async () => {
  const alice = await registerTestUser('sy-e', 'pw-sy-e');
  const bob = await registerTestUser('sy-e-b', 'pw-sy-e-b');
  const tok = alice.access_token!;
  const roomId = await createRoom(tok, { preset: 'public_chat' });
  const since = (await sync(tok)).body.next_batch as string;
  await sendText(tok, roomId, 'cross-user', 'sy-e-1');
  // bob's sync with alice's token: valid position, bob sees no rooms
  const res = await sync(
    bob.access_token!,
    `&since=${encodeURIComponent(since)}`,
  );
  assertEquals(res.status, 200);
  assertEquals(typeof res.body.next_batch, 'string');
});

Deno.test('sync: presence on join, both ways', async () => {
  const alice = await registerTestUser('sy-f', 'pw-sy-f');
  const bob = await registerTestUser('sy-f-b', 'pw-sy-f-b');
  const A = alice.access_token!;
  const B = bob.access_token!;

  await call(
    `/_matrix/client/v3/presence/${encodeURIComponent(bob.user_id)}/status`,
    {
      method: 'PUT',
      token: B,
      body: { presence: 'online' },
    },
  );

  const roomId = await createRoom(A, { preset: 'public_chat' });
  const aliceSince = (await sync(A)).body.next_batch as string;
  const bobSince = (await sync(B)).body.next_batch as string;

  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    token: B,
    body: {},
  });

  // the joiner -> the syncer
  const aliceRes = await sync(A, `&since=${encodeURIComponent(aliceSince)}`);
  const alicePresence = (aliceRes.body.presence as Json).events as Json[];
  assert(
    alicePresence.some((e) =>
      e.sender === bob.user_id &&
      (e.content as Json).presence === 'online'
    ),
    "alice did not see bob's presence on his join",
  );

  // the syncer IS the joiner -> every member's presence
  const bobRes = await sync(B, `&since=${encodeURIComponent(bobSince)}`);
  const bobPresence = (bobRes.body.presence as Json).events as Json[];
  assert(
    bobPresence.some((e) => e.sender === alice.user_id),
    "bob did not see alice's presence on his join",
  );
});

Deno.test('sync: summary counts on join rooms', async () => {
  const alice = await registerTestUser('sy-g', 'pw-sy-g');
  const bob = await registerTestUser('sy-g-b', 'pw-sy-g-b');
  const tok = alice.access_token!;
  const roomId = await createRoom(tok, { invite: [bob.user_id] });
  const res = await sync(tok);
  const summary = (((res.body.rooms as Json).join as Json)[roomId] as Json)
    .summary as Json;
  assertEquals(summary['m.joined_member_count'], 1);
  assertEquals(summary['m.invited_member_count'], 1);
});

Deno.test("sync: unsigned.membership flips at the viewer's own join", async () => {
  const alice = await registerTestUser('sy-h', 'pw-sy-h');
  const bob = await registerTestUser('sy-h-b', 'pw-sy-h-b');
  const A = alice.access_token!;
  const B = bob.access_token!;

  const roomId = await createRoom(A, { preset: 'public_chat' });
  await sendText(A, roomId, 'prejoin', 'sy-h-1');
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    token: B,
    body: {},
  });
  await sendText(A, roomId, 'postjoin', 'sy-h-2');

  const res = await sync(B);
  const tl = (((res.body.rooms as Json).join as Json)[roomId] as Json)
    .timeline as Json;
  let seenJoin = false;
  for (const ev of tl.events as Json[]) {
    if (ev.type === 'm.room.member' && ev.state_key === bob.user_id) {
      seenJoin = true;
    }
    const membership = (ev.unsigned as Json).membership;
    assertEquals(
      membership,
      seenJoin ? 'join' : 'leave',
      `wrong membership on ${ev.event_id}`,
    );
  }
  assert(seenJoin, "bob's join not in the timeline");
});

Deno.test('sync: unsigned.prev_content on a state change — the join after an invite carries the invite (is_direct)', async () => {
  const alice = await registerTestUser('sy-pc-a', 'pw-sy-pc-a');
  const bob = await registerTestUser('sy-pc-b', 'pw-sy-pc-b');
  const A = alice.access_token!;
  const B = bob.access_token!;
  const roomId = await createRoom(A, {
    preset: 'private_chat',
    invite: [bob.user_id],
    is_direct: true,
  });
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    token: B,
    body: {},
  });
  const sync = await call('/_matrix/client/v3/sync?timeout=0', { token: B });
  const timeline = (((sync.body.rooms as Json).join as Json)[roomId] as Json)
    .timeline as Json;
  const events = (timeline.events as Json[]) ?? [];
  const join = events.find((e) =>
    e.type === 'm.room.member' && e.state_key === bob.user_id &&
    (e.content as Json).membership === 'join'
  );
  assert(join !== undefined, `bob's join in the timeline: ${events.length}`);
  const unsigned = join.unsigned as Json;
  assertEquals(
    (unsigned.prev_content as Json).membership,
    'invite',
    'prev_content is the invite',
  );
  assertEquals((unsigned.prev_content as Json).is_direct, true);
  assertEquals(unsigned.prev_sender, alice.user_id);
});

Deno.test('sync: state at the timeline start includes the start event’s own effect (the s2 fork shape)', async () => {
  const alice = await registerTestUser('sy-s2-a', 'pw-sy-s2-a');
  const A = alice.access_token!;
  const roomId = await createRoom(A, { preset: 'public_chat' });
  const { author, ingestEvent } = await import('#engine/ingest.ts');
  const { latestExtremityEventId } = await import('./util.ts');
  const e1 = await (async () => {
    const tip = await latestExtremityEventId(roomId);
    const pdu = await author(roomId, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: { msgtype: 'm.text', body: 'E1' },
      prev_events: [tip],
    });
    await ingestEvent(roomId, pdu);
    return String(pdu.event_id);
  })();
  // E3, E4 in order
  for (const body of ['E3', 'E4']) {
    const tip = await latestExtremityEventId(roomId);
    const pdu = await author(roomId, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: { msgtype: 'm.text', body },
      prev_events: [tip],
    });
    await ingestEvent(roomId, pdu);
  }
  // s2 (the room name) forks off E1 and arrives LATE
  const s2 = await author(roomId, {
    type: 'm.room.name',
    state_key: '',
    sender: alice.user_id,
    content: { name: 'I am the room name, S2' },
    prev_events: [e1],
  });
  await ingestEvent(roomId, s2);
  const s2Id = String(s2.event_id);
  // E5 merges, of a filtered type
  const e5 = await author(roomId, {
    type: 'please_filter_me',
    sender: alice.user_id,
    content: { msgtype: 'm.text', body: 'E5' },
    prev_events: [await latestExtremityEventId(roomId)],
  });
  await ingestEvent(roomId, e5);

  const sync = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' +
      encodeURIComponent(
        '{"room":{"timeline":{"not_types":["please_filter_me"],"limit":1}}}',
      ),
    { token: A },
  );
  assertEquals(sync.status, 200);
  const room = ((sync.body.rooms as Json).join as Json)[roomId] as Json;
  const stateEvents = ((room.state as Json).events as Json[]) ?? [];
  assert(
    stateEvents.some((e) => e.event_id === s2Id),
    `s2 in state.events: ${JSON.stringify(stateEvents.map((e) => e.event_id))}`,
  );
});
