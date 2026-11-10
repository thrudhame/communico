import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP room tags and account-data stream');
async function call(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
suite.test('tags share atomic account data and incremental sync, including concurrent writes', async () => {
  const alice = await suite.registerTestUser('tag-a', 'pw');
  const bob = await suite.registerTestUser('tag-b', 'pw');
  const token = alice.access_token!;
  const created = await call(
    '/_matrix/client/v3/createRoom',
    token,
    'POST',
    {},
  );
  const room = String(created.body.room_id);
  const base = '/_matrix/client/v3/user/' + encodeURIComponent(alice.user_id) +
    '/rooms/' + encodeURIComponent(room);
  assertEquals((await call(base + '/tags', token)).body, { tags: {} });
  const initial = await call('/_matrix/client/v3/sync?timeout=0', token);
  const waiting = call(
    '/_matrix/client/v3/sync?timeout=5000&since=' + initial.body.next_batch,
    token,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const start = performance.now();
  assertEquals(
    (await call(base + '/tags/m.favourite', token, 'PUT', { order: 0.3 }))
      .status,
    200,
  );
  const next = await waiting;
  assert(performance.now() - start < 1000, 'tag writes wake a waiting sync');
  const entry = ((next.body.rooms as Json).join as Json)[room] as Json;
  assertEquals((entry.account_data as Json).events, [{
    type: 'm.tag',
    content: { tags: { 'm.favourite': { order: 0.3 } } },
  }]);
  const unchanged = await call(
    '/_matrix/client/v3/sync?timeout=0&since=' + next.body.next_batch,
    token,
  );
  assertEquals(((unchanged.body.rooms as Json).join as Json)[room], undefined);
  const updates = await Promise.all(
    ['u.one', 'u.two'].map((tag) =>
      call(base + '/tags/' + tag, token, 'PUT', { order: 0.5 })
    ),
  );
  assertEquals(updates.map((v) => v.status), [200, 200]);
  const stored = await call(base + '/account_data/m.tag', token);
  assertEquals(Object.keys(stored.body.tags as Json).sort(), [
    'm.favourite',
    'u.one',
    'u.two',
  ]);
  assertEquals((await call(base + '/tags', token)).body, stored.body);
  assertEquals((await call(base + '/tags/u.one', token, 'DELETE')).status, 200);
  assertEquals((await call(base + '/tags/u.one', token, 'DELETE')).status, 200);
  assertEquals((await call(base + '/tags', bob.access_token!)).status, 403);
  assertEquals(
    (await call(base + '/tags/u.x', bob.access_token!, 'PUT', {})).status,
    403,
  );
  assertEquals(
    (await call(base + '/tags/u.x', bob.access_token!, 'DELETE')).status,
    403,
  );
  assertEquals(
    (await call(
      base.replace(
        encodeURIComponent(room),
        encodeURIComponent('!unknown:localhost'),
      ) + '/tags/u.x',
      token,
      'PUT',
      {},
    )).status,
    403,
  );
  assertEquals(
    (await call(
      base + '/tags/' + encodeURIComponent('é'.repeat(128)),
      token,
      'PUT',
      {},
    )).status,
    400,
  );
  for (const order of [-1, 1.1, 'bad', null]) {
    assertEquals(
      (await call(base + '/tags/u.bad', token, 'PUT', { order })).status,
      400,
    );
  }
  assertEquals(
    (await call(base + '/tags/u.bad', token, 'PUT', [])).status,
    400,
  );
  assertEquals(
    (await call(base + '/tags/' + 'a'.repeat(255), token, 'PUT', {})).status,
    200,
  );
  // Ordinary m.tag writes remain the same source of truth.
  assertEquals(
    (await call(base + '/account_data/m.tag', token, 'PUT', {
      tags: { 'u.external': {} },
    })).status,
    200,
  );
  assertEquals((await call(base + '/tags', token)).body, {
    tags: { 'u.external': {} },
  });
});
