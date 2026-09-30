// tests/messages-end.test.ts — §3.3 of the fix pass: /messages emits `end`
// whenever events remain, filtered or not; `end` is omitted only at the
// walk's true end (the create, with everything before it received).
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

Deno.test('/messages end: filtered window keeps end; the next call is an empty chunk with no end; unfiltered full walk omits end', async () => {
  const alice = await registerTestUser('me-a', 'pw-me-a');
  const token = alice.access_token!;
  const create = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token,
    body: { preset: 'private_chat' },
  });
  assertEquals(create.status, 200);
  const roomId = String(create.body.room_id);
  const send = async (body: Json, txn: string) => {
    const res = await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/${txn}`,
      { method: 'PUT', token, body },
    );
    assertEquals(res.status, 200);
  };
  await send({ msgtype: 'm.text', body: 'plain one' }, 'me1');
  await send(
    { msgtype: 'm.text', body: 'with link', url: 'https://example.test/x' },
    'me2',
  );
  await send({ msgtype: 'm.text', body: 'plain two' }, 'me3');

  // the raw window (limit 10 > 5 events) reaches the create, but the
  // contains_url filter drops rows from the chunk — end must be present
  const filtered = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=10&filter=${
      encodeURIComponent('{"contains_url":true}')
    }`,
    { token },
  );
  assertEquals(filtered.status, 200);
  const fchunk = (filtered.body.chunk as Json[]) ?? [];
  assertEquals(fchunk.length, 1);
  assertEquals((fchunk[0].content as Json).body, 'with link');
  assert(
    typeof filtered.body.end === 'string',
    `end present after a filtered window: ${JSON.stringify(filtered.body)}`,
  );

  // following it: an empty chunk with no end — the true end
  const next = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=10&filter=${
      encodeURIComponent('{"contains_url":true}')
    }&from=${encodeURIComponent(String(filtered.body.end))}`,
    { token },
  );
  assertEquals(next.status, 200);
  assertEquals(((next.body.chunk as Json[]) ?? []).length, 0);
  assertEquals(next.body.end, undefined);

  // unfiltered, the same small room: the walk ends at the create — no end
  const full = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=10`,
    { token },
  );
  assertEquals(full.status, 200);
  assertEquals(full.body.end, undefined);
});
