// Every searchable content shape crosses the same projection normalizer.
import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP search NUL normalization');
type Json = Record<string, unknown>;

suite.test('NUL becomes a searchable space for body, name and both topic shapes without changing events', async () => {
  const alice = await suite.registerTestUser('nul-search', 'pw');
  const call = async (path: string, method: string, body: unknown) => {
    const res = await suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method,
        headers: { Authorization: 'Bearer ' + alice.access_token },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(res.status, 200);
    return await res.json() as Json;
  };
  const id = String((await call('createRoom', 'POST', {})).room_id);
  const base = 'rooms/' + encodeURIComponent(id);
  for (
    const [key, path, content] of [
      ['content.body', '/send/m.room.message/nul', {
        body: 'Left\u0000Right',
        msgtype: 'm.text',
      }],
      ['content.name', '/state/m.room.name', { name: 'Left\u0000Right' }],
      ['content.topic', '/state/m.room.topic', { topic: 'Left\u0000Right' }],
      ['content.topic', '/state/m.room.topic', {
        'm.topic': { 'm.text': [{ body: 'Left\u0000Right' }] },
      }],
    ] as const
  ) {
    const event = await call(base + path, 'PUT', content);
    const found = await call('search', 'POST', {
      search_categories: {
        room_events: { search_term: 'left right', keys: [key] },
      },
    });
    const category = (found.search_categories as Json).room_events as Json;
    const results = category.results as Json[];
    const result = results.map((r) => r.result as Json).find((e) =>
      e.event_id === event.event_id
    );
    assertEquals(
      result?.content,
      content,
      key + ': search finds normalized text and returns immutable content',
    );
    assertEquals(
      results.find((r) => (r.result as Json).event_id === event.event_id)?.rank,
      1,
      key + ': NUL separates indexed words for ranking',
    );
  }
});
