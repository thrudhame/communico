import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP directory operation contracts');
type Json = Record<string, unknown>;
async function call(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

suite.test('empty producers retain authenticated discovery and read contracts', async () => {
  const user = await suite.registerTestUser('operation-empty', 'pw');
  for (
    const [path, expected] of [
      ['thirdparty/protocols', {}],
      ['thirdparty/user/unknown', []],
      ['thirdparty/location/unknown', []],
      ['thirdparty/user?userid=%40nobody%3Aexample.test', []],
      ['thirdparty/location?alias=%23missing%3Aexample.test', []],
      ['account/3pid', { threepids: [] }],
    ] as const
  ) {
    const response = await call(path, user.access_token);
    assertEquals<unknown>(response, { status: 200, body: expected }, path);
    assertEquals((await call(path)).status, 401, path);
  }
  const protocol = await call('thirdparty/protocol/unknown', user.access_token);
  assertEquals([protocol.status, protocol.body.errcode], [404, 'M_NOT_FOUND']);
  for (const path of ['thirdparty/user', 'thirdparty/location']) {
    assertEquals((await call(path, user.access_token)).status, 400, path);
  }
});

suite.test('profile capability compatibility fields match enabled profile actions', async () => {
  const user = await suite.registerTestUser('operation-capabilities', 'pw');
  const response = await call('capabilities', user.access_token);
  const capabilities = response.body.capabilities as Json;
  assertEquals(capabilities['m.set_displayname'], { enabled: true });
  assertEquals(capabilities['m.set_avatar_url'], { enabled: true });
});

suite.test('omitted directory visibility defaults to public', async () => {
  const user = await suite.registerTestUser('operation-visibility', 'pw');
  const room = await call('createRoom', user.access_token, {});
  assertEquals(room.status, 200);
  const path = 'directory/list/room/' +
    encodeURIComponent(String(room.body.room_id));
  assertEquals((await call(path, user.access_token, {}, 'PUT')).status, 200);
  assertEquals((await call(path)).body, { visibility: 'public' });
  assertEquals(
    (await call(path, user.access_token, { visibility: null }, 'PUT')).status,
    400,
  );
});

suite.test('named bridge directory is empty, never the native room list', async () => {
  const user = await suite.registerTestUser('operation-network', 'pw');
  const room = await call('createRoom', user.access_token, {
    visibility: 'public',
    name: 'Native directory room',
  });
  assertEquals(room.status, 200);
  const response = await call('publicRooms', user.access_token, {
    third_party_instance_id: 'unknown',
  });
  assertEquals(response, {
    status: 200,
    body: { chunk: [], total_room_count_estimate: 0 },
  });
});

suite.test('conflicting network selectors are rejected before selection', async () => {
  const user = await suite.registerTestUser('operation-network-conflict', 'pw');
  assertEquals(
    (await call('publicRooms', user.access_token, {
      include_all_networks: true,
      third_party_instance_id: 'unknown',
    })).status,
    400,
  );
});

for (
  const [field, value] of [
    ['limit', 1.5],
    ['limit', '1'],
    ['limit', null],
    ['since', 1],
    ['filter', []],
    ['filter', null],
    ['filter', { generic_search_term: 3 }],
    ['include_all_networks', 'true'],
    ['third_party_instance_id', 2],
  ] as const
) {
  suite.test(
    'publicRooms rejects malformed body ' + JSON.stringify({ [field]: value }),
    async () => {
      const user = await suite.registerTestUser(
        'operation-bad-' + crypto.randomUUID().slice(0, 8),
        'pw',
      );
      assertEquals(
        (await call('publicRooms', user.access_token, { [field]: value }))
          .status,
        400,
      );
    },
  );
}

for (const query of ['limit=1.5', 'limit=no', 'since=1junk', 'since=-1']) {
  suite.test('publicRooms rejects malformed query ' + query, async () => {
    const user = await suite.registerTestUser(
      'operation-query-' + crypto.randomUUID().slice(0, 8),
      'pw',
    );
    assertEquals(
      (await call('publicRooms?' + query, user.access_token)).status,
      400,
    );
  });
}
