import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP room discovery');
async function call(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function ok(
  path: string,
  token?: string,
  body?: unknown,
  method?: string,
) {
  const response = await call(path, token, body, method);
  assertEquals(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function create(token: string, content: Json) {
  return String((await ok('v3/createRoom', token, content)).room_id);
}
const roomPath = (room: string) => 'v3/rooms/' + encodeURIComponent(room);

suite.test('client and federation public directories filter room types before count and pagination', async () => {
  const a = await suite.registerTestUser('discovery-types', 'pw');
  const plain = await create(a.access_token!, {
    name: 'discover plain',
    visibility: 'public',
  });
  const space = await create(a.access_token!, {
    name: 'discover space',
    visibility: 'public',
    creation_content: { type: 'm.space' },
  });
  const custom = await create(a.access_token!, {
    name: 'discover custom',
    visibility: 'public',
    creation_content: { type: 'org.example' },
  });
  const fed = fedCaller(suite.matrix, await remoteServer());
  for (
    const post of [
      (body: Json) => call('v3/publicRooms', a.access_token!, body),
      (body: Json) => fed('POST', '/_matrix/federation/v1/publicRooms', body),
    ]
  ) {
    for (
      const [types, ids] of [[['m.space'], [space]], [[null], [plain]], [[
        'org.example',
      ], [custom]], [[], []]] as const
    ) {
      const response = await post({ filter: { room_types: types } });
      assertEquals(response.status, 200);
      assertEquals((response.body.chunk as Json[]).map((r) => r.room_id), [
        ...ids,
      ]);
      assertEquals(response.body.total_room_count_estimate, ids.length);
    }
    const page = await post({
      filter: { room_types: [null, 'm.space'] },
      limit: 1,
    });
    assertEquals(page.body.total_room_count_estimate, 2);
    const next = await post({
      filter: { room_types: [null, 'm.space'] },
      limit: 1,
      since: page.body.next_batch,
    });
    const entries = [
      ...page.body.chunk as Json[],
      ...next.body.chunk as Json[],
    ];
    assertEquals(
      entries.find((r) => r.room_id === space)!.room_type,
      'm.space',
    );
    assertEquals(
      'room_type' in entries.find((r) => r.room_id === plain)!,
      false,
    );
    for (const room_types of ['m.space', [3], [true], {}]) {
      assertEquals((await post({ filter: { room_types } })).status, 400);
    }
  }
});

suite.test('user directory includes unlisted world-readable rooms but not private unrelated rooms', async () => {
  const a = await suite.registerTestUser('discovery-world', 'pw');
  const b = await suite.registerTestUser('discovery-searcher', 'pw');
  const room = await create(a.access_token!, {});
  const search = () =>
    ok('v3/user_directory/search', b.access_token!, {
      search_term: 'discovery-world',
    });
  assertEquals((await search()).results, []);
  await ok(
    roomPath(room) + '/state/m.room.history_visibility',
    a.access_token!,
    { history_visibility: 'world_readable' },
    'PUT',
  );
  assertEquals(((await search()).results as Json[]).map((r) => r.user_id), [
    a.user_id,
  ]);
  await ok(
    roomPath(room) + '/state/m.room.history_visibility',
    a.access_token!,
    { history_visibility: 'joined' },
    'PUT',
  );
  assertEquals((await search()).results, []);
});
