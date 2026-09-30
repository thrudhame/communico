// tests/messages-tokens.test.ts — §3.2 of the fix pass: /messages from/to
// accept what /sync mints (the five-part s<e>_p<p>_t<t>_r<r>_a<a>), a
// garbage token is 400 M_INVALID_PARAM (never a silent restart), and the
// c<n>_<offset> round trip is unchanged.
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

async function sendText(
  token: string,
  roomId: string,
  text: string,
  txn: string,
): Promise<void> {
  const res = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/${txn}`,
    { method: 'PUT', token, body: { msgtype: 'm.text', body: text } },
  );
  assertEquals(res.status, 200);
}

function bodies(events: Json[]): string[] {
  return events.map((e) => String((e.content as Json).body ?? ''));
}

Deno.test('/messages: /sync next_batch works as from (dir=f and dir=b); from+to bounds; garbage → 400; c-token round trip', async () => {
  const alice = await registerTestUser('mt-a', 'pw-mt-a');
  const token = alice.access_token!;
  const create = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token,
    body: { preset: 'private_chat' },
  });
  assertEquals(create.status, 200);
  const roomId = String(create.body.room_id);

  await sendText(token, roomId, 'm1', 'mt1');
  await sendText(token, roomId, 'm2', 'mt2');
  const sync1 = await call('/_matrix/client/v3/sync?timeout=0', { token });
  const nb1 = String(sync1.body.next_batch);
  assert(
    /^s\d+_p\d+_t\d+_r\d+_a\d+$/.test(nb1),
    `next_batch is five-part: ${nb1}`,
  );
  await sendText(token, roomId, 'm3', 'mt3');
  await sendText(token, roomId, 'm4', 'mt4');
  const sync2 = await call('/_matrix/client/v3/sync?timeout=0', { token });
  const nb2 = String(sync2.body.next_batch);
  await sendText(token, roomId, 'm5', 'mt5');

  // dir=f from a five-part next_batch: only events after it
  const fwd = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=f&from=${encodeURIComponent(nb1)}`,
    { token },
  );
  assertEquals(fwd.status, 200);
  assertEquals(bodies((fwd.body.chunk as Json[]) ?? []), ['m3', 'm4', 'm5']);

  // from+to bounds the window
  const bounded = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=f&from=${encodeURIComponent(nb1)}&to=${
      encodeURIComponent(nb2)
    }`,
    { token },
  );
  assertEquals(bounded.status, 200);
  assertEquals(bodies((bounded.body.chunk as Json[]) ?? []), ['m3', 'm4']);

  // dir=b from a five-part token: inclusive of the token's position
  const back = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=4&from=${encodeURIComponent(nb2)}`,
    { token },
  );
  assertEquals(back.status, 200);
  assertEquals(bodies((back.body.chunk as Json[]) ?? []), [
    'm4',
    'm3',
    'm2',
    'm1',
  ]);

  // a garbage token is a client error, not a silent restart
  const garbage = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=f&from=not-a-token`,
    { token },
  );
  assertEquals(garbage.status, 400);
  assertEquals(garbage.body.errcode, 'M_INVALID_PARAM');

  // the c<n>_<offset> round trip is unchanged
  const page1 = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=2`,
    { token },
  );
  assertEquals(page1.status, 200);
  const end = String(page1.body.end);
  assert(/^c\d+_\d+$/.test(end), `end is a c-token: ${end}`);
  const page2 = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=2&from=${encodeURIComponent(end)}`,
    { token },
  );
  assertEquals(page2.status, 200);
  assertEquals(bodies((page2.body.chunk as Json[]) ?? []), ['m3', 'm2']);
});
