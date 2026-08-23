import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { eventIdFor, redact } from '../api/engine/eventid.ts';

const PDU = {
  type: 'm.room.message',
  room_id: '!r:localhost',
  sender: '@dev:localhost',
  content: { body: 'hello', msgtype: 'm.text' },
  prev_events: ['$abc'],
  origin_server_ts: 1000,
  depth: 0,
};

Deno.test('eventIdFor: shape is $ + 43 base64url chars', async () => {
  const id = await eventIdFor(PDU);
  assert(/^\$[A-Za-z0-9_-]{43}$/.test(id), `bad shape: ${id}`);
});

Deno.test('eventIdFor: deterministic', async () => {
  assertEquals(await eventIdFor(PDU), await eventIdFor({ ...PDU }));
});

Deno.test('eventIdFor: redacted content does not change the ID', async () => {
  const other = await eventIdFor({
    ...PDU,
    content: { body: 'completely different', msgtype: 'm.image' },
  });
  assertEquals(await eventIdFor(PDU), other);
});

Deno.test('eventIdFor: sender changes the ID', async () => {
  const other = await eventIdFor({ ...PDU, sender: '@other:localhost' });
  assertNotEquals(await eventIdFor(PDU), other);
});

Deno.test('redact: m.room.member keeps only membership in content', () => {
  const r = redact({
    type: 'm.room.member',
    sender: '@a:b',
    state_key: '@c:d',
    content: { membership: 'join', displayname: 'X', avatar_url: 'mxc://y' },
  });
  assertEquals(r.content, { membership: 'join' });
});

Deno.test('redact: m.room.create keeps content unchanged', () => {
  const content = { creator: '@a:b', room_version: '10', extra: true };
  const r = redact({ type: 'm.room.create', sender: '@a:b', content });
  assertEquals(r.content, content);
});
