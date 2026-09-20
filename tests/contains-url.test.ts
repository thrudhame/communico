// tests/contains-url.test.ts — band C item 4: /messages honours the
// RoomEventFilter's contains_url (spec v1.16 room_event_filter.yaml
// :53-56; plan: content.url is a string). Live doltgres, HTTP-level via
// the real endpoint trees.
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

Deno.test('/messages filter contains_url: only events whose content.url is a string', async () => {
  const alice = await registerTestUser('cu-a', 'pw-cu-a');
  const tok = alice.access_token!;
  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {},
  })).body.room_id as string;
  const send = (txn: string, content: unknown) =>
    call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/${txn}`,
      { method: 'PUT', token: tok, body: content },
    );
  assertEquals(
    (await send('cu-1', { msgtype: 'm.text', body: 'plain text' })).status,
    200,
  );
  assertEquals(
    (await send('cu-2', {
      msgtype: 'm.file',
      body: 'test.png',
      url: 'mxc://example/abc',
    })).status,
    200,
  );

  const withUrl = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&filter=${encodeURIComponent('{"contains_url":true}')}`,
    { token: tok },
  );
  assertEquals(withUrl.status, 200);
  const chunk = withUrl.body.chunk as Json[];
  assertEquals(chunk.length, 1);
  assertEquals((chunk[0].content as Json).msgtype, 'm.file');
  // Synapse's end rule (pagination.py:668-706): a non-empty RAW page
  // carries end even when the filter emptied the chunk —
  // TestRoomImageRoundtrip's exact assertion shape
  assertEquals(typeof withUrl.body.end, 'string');

  const withoutUrl = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&filter=${encodeURIComponent('{"contains_url":false}')}`,
    { token: tok },
  );
  const negChunk = (withoutUrl.body.chunk as Json[]).filter((e) =>
    e.type === 'm.room.message'
  );
  assertEquals(negChunk.length, 1);
  assertEquals((negChunk[0].content as Json).msgtype, 'm.text');
});
