import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP search operation contracts');
type Json = Record<string, unknown>;
let token = '', otherToken = '', user = '', roomA = '', roomB = '';
const ids: string[] = [];
async function call(
  path: string,
  body: unknown,
  method = 'POST',
  auth = token,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + auth },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function search(criteria: Json, next?: string) {
  const response = await call(
    'search' +
      (next === undefined ? '' : '?next_batch=' + encodeURIComponent(next)),
    {
      search_categories: {
        room_events: { search_term: 'needle', ...criteria },
      },
    },
  );
  assertEquals(response.status, 200);
  return (response.body.search_categories as Json).room_events as Json;
}
const eventIds = (page: Json) =>
  (page.results as Json[]).map((r) => (r.result as Json).event_id);
suite.test('prepare distinct rooms, senders, keys and tied ranks', async () => {
  const a = await suite.registerTestUser('operation-search-a', 'pw');
  const b = await suite.registerTestUser('operation-search-b', 'pw');
  token = a.access_token!;
  otherToken = b.access_token!;
  user = a.user_id;
  for (const name of ['A', 'B']) {
    const created = await call('createRoom', { preset: 'public_chat', name });
    assertEquals(created.status, 200);
    const room = String(created.body.room_id);
    if (name === 'A') roomA = room;
    else roomB = room;
    assertEquals(
      (await call(
        'rooms/' + encodeURIComponent(room) + '/join',
        {},
        'POST',
        otherToken,
      )).status,
      200,
    );
  }
  for (let i = 0; i < 5; i++) {
    const sent = await call(
      'rooms/' + encodeURIComponent(i % 2 === 0 ? roomA : roomB) +
        '/send/m.room.message/s' + i,
      {
        body: i === 0 ? 'needle other words' : 'needle',
        msgtype: 'm.text',
      },
      'PUT',
      i < 3 ? token : otherToken,
    );
    assertEquals(sent.status, 200);
    ids.push(String(sent.body.event_id));
  }
});
for (const order_by of ['rank', 'recent']) {
  suite.test(
    order_by +
      ' consumes every continuation once and omits completed continuations',
    async () => {
      const criteria = { order_by, filter: { limit: 2 } };
      let next: string | undefined;
      const found: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const page = await search(criteria, next);
        assertEquals(page.count, 5);
        found.push(...eventIds(page));
        if (i < 2) {
          assert(typeof page.next_batch === 'string');
          next = page.next_batch;
        } else assertEquals(page.next_batch, undefined);
      }
      assertEquals(found, [...ids].reverse());
    },
  );
  for (const key of ['room_id', 'sender']) {
    suite.test(
      order_by + ' ' + key +
        ' continuation stays in its group and has an honest end',
      async () => {
        const criteria = {
          order_by,
          filter: { limit: key === 'sender' ? 3 : 2 },
          groupings: { group_by: [{ key }] },
        };
        const first = await search(criteria);
        const groupValue = key === 'room_id' ? roomA : user;
        const groups = (first.groups as Json)[key] as Json;
        const group = groups[groupValue] as Json;
        assert(typeof group.next_batch === 'string');
        const second = await search(criteria, group.next_batch);
        const events = (second.results as Json[]).map((r) => r.result as Json);
        assert(events.length > 0);
        assert(events.every((event) => event[key] === groupValue));
        const all = [...group.results as string[], ...eventIds(second)];
        assertEquals(new Set(all).size, all.length);
        if (key === 'room_id') {
          assertEquals(all.length, 3);
          assertEquals(second.next_batch, undefined);
        }
      },
    );
  }
}
suite.test('exact and zero limits do not advertise nonexistent progress', async () => {
  assertEquals(
    (await search({ filter: { limit: 5 }, order_by: 'recent' })).next_batch,
    undefined,
  );
  const zero = await search({ filter: { limit: 0 } });
  assertEquals(zero.count, 5);
  assertEquals(zero.results, []);
  assertEquals(zero.next_batch, undefined);
});
suite.test('explicit search keys, scope, context and state reach their consumers', async () => {
  assertEquals(eventIds(await search({ keys: [] })), []);
  assertEquals(eventIds(await search({ keys: ['content.topic'] })), []);
  const found = await search({
    keys: ['content.body'],
    filter: { rooms: [roomA], senders: [user], limit: 1 },
    event_context: { before_limit: 0, after_limit: 0, include_profile: true },
    include_state: true,
  });
  assertEquals(found.count, 2);
  const result = (found.results as Json[])[0];
  assertEquals((result.result as Json).event_id, ids[2]);
  assertEquals((result.context as Json).events_before, []);
  assertEquals((result.context as Json).events_after, []);
  assert(Object.hasOwn((result.context as Json).profile_info as Json, user));
  assert(Object.hasOwn(found.state as Json, roomA));
});
for (
  const bad of [
    { keys: null },
    { keys: 'content.body' },
    { keys: [5] },
    { keys: ['unknown'] },
    { event_context: null },
    { event_context: [] },
    { event_context: { before_limit: 1.5 } },
    { event_context: { before_limit: '1' } },
    { event_context: { after_limit: -1 } },
    { event_context: { include_profile: 'true' } },
    { include_state: 'false' },
    { groupings: [] },
    { groupings: { group_by: 'room_id' } },
    { groupings: { group_by: [null] } },
    { groupings: { group_by: [{ key: 5 }] } },
    { groupings: { group_by: [{ key: 'unknown' }] } },
    { filter: { senders: [false] } },
  ]
) {
  suite.test(
    'search rejects malformed known fields ' + JSON.stringify(bad),
    async () => {
      assertEquals(
        (await call('search', {
          search_categories: { room_events: { search_term: 'needle', ...bad } },
        })).status,
        400,
      );
    },
  );
}
