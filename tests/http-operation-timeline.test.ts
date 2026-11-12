import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP timeline and sync operation contracts');
type Json = Record<string, unknown>;
async function call(
  path: string,
  token: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
let token = '', userId = '', room = '', event = '';
suite.test('prepare timeline operation fixtures', async () => {
  const a = await suite.registerTestUser('operation-timeline-a', 'pw');
  const b = await suite.registerTestUser('operation-timeline-b', 'pw');
  token = a.access_token!;
  userId = a.user_id;
  const created = await call('createRoom', token, { preset: 'public_chat' });
  assertEquals(created.status, 200);
  room = String(created.body.room_id);
  const base = 'rooms/' + encodeURIComponent(room);
  assertEquals((await call(base + '/join', b.access_token!, {})).status, 200);
  for (
    const [sender, type, body] of [[token, 'm.room.message', 'first'], [
      b.access_token!,
      'm.room.message',
      'other',
    ], [token, 'org.example.other', 'latest']] as const
  ) {
    const sent = await call(
      base + '/send/' + type + '/' + crypto.randomUUID(),
      sender,
      { body, msgtype: 'm.text' },
      'PUT',
    );
    assertEquals(sent.status, 200);
    event = String(sent.body.event_id);
  }
});

for (
  const [filter, expected] of [
    [{ types: ['m.room.message'], senders: ['SELF'], limit: 1 }, ['first']],
    [{
      not_types: ['org.example.*'],
      not_senders: ['SELF'],
      types: ['m.room.message'],
    }, ['other']],
    [{ rooms: ['!other:example.test'] }, []],
    [{ not_rooms: ['ROOM'] }, []],
    [{ limit: 0 }, []],
  ] as const
) {
  suite.test(
    'messages applies the complete shared event filter ' +
      JSON.stringify(filter),
    async () => {
      const normalized = JSON.parse(
        JSON.stringify(filter).replaceAll('SELF', userId).replaceAll(
          'ROOM',
          room,
        ),
      );
      const response = await call(
        'rooms/' + encodeURIComponent(room) +
          '/messages?dir=b&limit=10&filter=' +
          encodeURIComponent(JSON.stringify(normalized)),
        token,
      );
      assertEquals(response.status, 200);
      assertEquals(
        (response.body.chunk as Json[]).map((e) => (e.content as Json).body),
        [...expected],
      );
    },
  );
}

for (const target of ['messages', 'context']) {
  for (
    const bad of [
      'limit=no',
      'limit=1.5',
      'filter=null',
      'filter=[]',
      'filter=' + encodeURIComponent('{"types":3}'),
      'filter=' + encodeURIComponent('{"contains_url":"false"}'),
    ]
  ) {
    suite.test(target + ' rejects malformed ' + bad, async () => {
      const suffix = target === 'messages'
        ? '/messages?dir=b&'
        : '/context/' + encodeURIComponent(event) + '?';
      assertEquals(
        (await call('rooms/' + encodeURIComponent(room) + suffix + bad, token))
          .status,
        400,
      );
    });
  }
}
suite.test('sync defaults presence to online at the real presence reader', async () => {
  const presence = 'presence/' + encodeURIComponent(userId) + '/status';
  assertEquals(
    (await call(presence, token, { presence: 'offline' }, 'PUT')).status,
    200,
  );
  assertEquals((await call('sync?timeout=0', token)).status, 200);
  assertEquals((await call(presence, token)).body.presence, 'online');
  for (const value of ['offline', 'unavailable', 'online']) {
    assertEquals(
      (await call('sync?timeout=0&set_presence=' + value, token)).status,
      200,
    );
    assertEquals((await call(presence, token)).body.presence, value);
  }
});
suite.test('full_state with since ignores the long-poll timeout', async () => {
  const initial = await call('sync?set_presence=offline', token);
  const start = performance.now();
  const full = await call(
    'sync?set_presence=offline&full_state=true&timeout=3000&since=' +
      initial.body.next_batch,
    token,
  );
  assertEquals(full.status, 200);
  assert(
    performance.now() - start < 1500,
    'full_state must not enter the 3000ms long poll',
  );
  const joined = ((full.body.rooms as Json).join as Json)[room] as Json;
  assert(
    ((joined.state as Json).events as Json[]).some((e) =>
      e.type === 'm.room.create'
    ),
  );
});
for (
  const query of [
    'full_state=yes',
    'use_state_after=no',
    'timeout=1.5',
    'timeout=no',
    'set_presence=unknown',
  ]
) {
  suite.test('sync rejects malformed ' + query, async () => {
    assertEquals((await call('sync?' + query, token)).status, 400);
  });
}
