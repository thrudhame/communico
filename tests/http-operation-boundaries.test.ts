import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP operation sibling negative contracts');
let token = '', room = '', event = '';
async function call(
  path: string,
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
  return { status: response.status, body: await response.json() };
}
suite.test('prepare operation sibling fixtures', async () => {
  token = (await suite.registerTestUser('operation-siblings', 'pw'))
    .access_token!;
  const created = await call('createRoom', { preset: 'public_chat' });
  assertEquals(created.status, 200);
  room = encodeURIComponent(created.body.room_id);
  const sent = await call('rooms/' + room + '/send/m.room.message/siblings', {
    msgtype: 'm.text',
    body: 'sibling event',
  }, 'PUT');
  assertEquals(sent.status, 200);
  event = encodeURIComponent(sent.body.event_id);
});

for (
  const field of [
    'types',
    'not_types',
    'senders',
    'not_senders',
    'rooms',
    'not_rooms',
  ]
) {
  for (const value of [null, 'not-an-array', {}, [null], [3]]) {
    suite.test(
      'messages/context reject malformed filter ' +
        JSON.stringify({ [field]: value }),
      async () => {
        const filter = encodeURIComponent(JSON.stringify({ [field]: value }));
        for (const suffix of ['/messages?dir=b&', '/context/' + event + '?']) {
          assertEquals(
            (await call('rooms/' + room + suffix + 'filter=' + filter)).status,
            400,
            suffix,
          );
        }
      },
    );
  }
}
for (
  const field of [
    'contains_url',
    'lazy_load_members',
    'include_redundant_members',
  ]
) {
  for (const value of [null, 'false', 0, [], {}]) {
    suite.test(
      'messages/context reject malformed boolean filter ' +
        JSON.stringify({ [field]: value }),
      async () => {
        const filter = encodeURIComponent(JSON.stringify({ [field]: value }));
        for (const suffix of ['/messages?dir=b&', '/context/' + event + '?']) {
          assertEquals(
            (await call('rooms/' + room + suffix + 'filter=' + filter)).status,
            400,
            suffix,
          );
        }
      },
    );
  }
}
for (const value of [null, '0', -1, 0.5, [], {}]) {
  suite.test(
    'messages/context reject malformed filter limit ' + JSON.stringify(value),
    async () => {
      const filter = encodeURIComponent(JSON.stringify({ limit: value }));
      for (const suffix of ['/messages?dir=b&', '/context/' + event + '?']) {
        assertEquals(
          (await call('rooms/' + room + suffix + 'filter=' + filter)).status,
          400,
          suffix,
        );
      }
    },
  );
}
for (
  const value of [
    '',
    '-1',
    'NaN',
    'Infinity',
    'true',
    '9007199254740992',
    '1junk',
  ]
) {
  suite.test(
    'messages/context reject malformed query limit ' + JSON.stringify(value),
    async () => {
      for (const suffix of ['/messages?dir=b&', '/context/' + event + '?']) {
        assertEquals(
          (await call(
            'rooms/' + room + suffix + 'limit=' + encodeURIComponent(value),
          )).status,
          400,
          suffix,
        );
      }
    },
  );
}
for (
  const field of [
    'full_state',
    'use_state_after',
    'org.matrix.msc4222.use_state_after',
  ]
) {
  for (const value of ['', 'TRUE', '1', 'False', 'null', 'yes']) {
    suite.test(
      'sync rejects malformed boolean ' + field + '=' + JSON.stringify(value),
      async () => {
        assertEquals(
          (await call('sync?' + field + '=' + encodeURIComponent(value)))
            .status,
          400,
        );
      },
    );
  }
}
for (
  const value of ['', '-1', 'NaN', 'Infinity', '9007199254740992', '1junk']
) {
  suite.test(
    'sync rejects malformed timeout ' + JSON.stringify(value),
    async () => {
      assertEquals(
        (await call('sync?timeout=' + encodeURIComponent(value))).status,
        400,
      );
    },
  );
}
suite.test('valid zero windows and unknown filter extensions remain distinct from malformed input', async () => {
  for (const suffix of ['/messages?dir=b&', '/context/' + event + '?']) {
    const response = await call(
      'rooms/' + room + suffix + 'limit=0&filter=' +
        encodeURIComponent(JSON.stringify({ 'org.example.future': { x: 1 } })),
    );
    assertEquals(response.status, 200);
    assertEquals(
      suffix.startsWith('/messages')
        ? response.body.chunk
        : response.body.events_before,
      [],
    );
    if (!suffix.startsWith('/messages')) {
      assertEquals(response.body.events_after, []);
    }
  }
  const response = await call(
    'sync?timeout=0&full_state=false&use_state_after=false',
  );
  assertEquals(response.status, 200);
});
