import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';
import { joinedUsers, listedRooms } from '#engine/server/directory.ts';
import { rankedDirectoryPage } from '#engine/server/directory-rank.ts';
import { project } from '#engine/server/project.ts';

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

suite.test('CHECKLISTSLOW: rank equals live recomputation after each publication change', async () => {
  const { server, store } = theApp();
  const check = async (
    change: string,
    perform: () => Promise<unknown>,
    expected: [string, number][],
  ) => {
    try {
      await perform();
      const rooms = await Promise.all(
        (await listedRooms(server)).map(async (id) => ({
          id,
          joined: (await joinedUsers(server, id)).length,
        })),
      );
      rooms.sort((a, b) => b.joined - a.joined || a.id.localeCompare(b.id));
      assertEquals(rooms, expected.map(([id, joined]) => ({ id, joined })));
      assertEquals(await rankedDirectoryPage(server, 0, 10), {
        total: rooms.length,
        rooms,
      });
    } catch (cause) {
      throw new Error(`after ${change}`, { cause });
    }
  };
  await check('fresh install', () => Promise.resolve(), []);
  const owner = await suite.registerTestUser('rank-owner', 'pw');
  const member = await suite.registerTestUser('rank-member', 'pw');
  const a = owner.access_token!, b = member.access_token!;
  const room = await create(a, { preset: 'public_chat' });
  const visible = (id: string, visibility: string) =>
    ok(
      'v3/directory/list/room/' + encodeURIComponent(id),
      a,
      { visibility },
      'PUT',
    );
  const action = (route: string, token: string, body: Json = {}) =>
    ok(roomPath(room) + '/' + route, token, body);
  await check('publish', () => visible(room, 'public'), [[room, 1]]);
  await check('join', () => action('join', b), [[room, 2]]);
  await check('leave', () => action('leave', b), [[room, 1]]);
  await action('join', b);
  await check('kick', () => action('kick', a, { user_id: member.user_id }), [[
    room,
    1,
  ]]);
  await action('join', b);
  await check('ban', () => action('ban', a, { user_id: member.user_id }), [[
    room,
    1,
  ]]);
  await check('name and topic edits', async () => {
    await ok(
      roomPath(room) + '/state/m.room.name',
      a,
      { name: 'Ranked name' },
      'PUT',
    );
    await ok(roomPath(room) + '/state/m.room.topic', a, {
      topic: 'Ranked topic',
    }, 'PUT');
    const body = await ok('v3/publicRooms', a, {
      filter: { generic_search_term: 'Ranked topic' },
    });
    assertEquals((body.chunk as Json[]).map((r) => r.name), ['Ranked name']);
  }, [[room, 1]]);
  await check('unpublish', () => visible(room, 'private'), []);
  await check('republish', () => visible(room, 'public'), [[room, 1]]);
  await check('publication replay', async () => {
    await project(store, room);
    await visible(room, 'public');
  }, [[room, 1]]);
  // Room type is immutable in Matrix; a space has a different create state.
  const space = await create(a, {
    preset: 'public_chat',
    creation_content: { type: 'm.space' },
  });
  const expected = [room, space].sort((x, y) => x.localeCompare(y)).map((
    id,
  ): [string, number] => [id, 1]);
  await check('publish a different room type', async () => {
    await visible(space, 'public');
    const body = await ok('v3/publicRooms', a, {
      filter: { room_types: ['m.space'] },
    });
    assertEquals((body.chunk as Json[]).map((r) => r.room_id), [space]);
  }, expected);
  await check(
    'last member leaves',
    () => ok(roomPath(space) + '/leave', a, {}),
    [[room, 1], [space, 0]],
  );
  await check(
    'purge marker after last member forgets',
    () => ok(roomPath(space) + '/forget', a, {}),
    [[room, 1]],
  );
  await check(
    'unpublish the remaining fixture',
    () => visible(room, 'private'),
    [],
  );
});

suite.test('room summaries share published metadata and enforce user or anonymous access without joining', async () => {
  const a = await suite.registerTestUser('summary-owner', 'pw');
  const b = await suite.registerTestUser('summary-outsider', 'pw');
  const privateRoom = await create(a.access_token!, {
    name: 'Private summary',
  });
  const path = (id: string) => 'v1/room_summary/' + encodeURIComponent(id);
  const own = await ok(path(privateRoom), a.access_token!);
  assertEquals(own.membership, 'join');
  assertEquals(own.name, 'Private summary');
  assertEquals(own.num_joined_members, 1);
  assertEquals((await call(path(privateRoom), b.access_token!)).status, 404);
  assertEquals((await call(path(privateRoom))).status, 404);
  await ok(roomPath(privateRoom) + '/invite', a.access_token!, {
    user_id: b.user_id,
  });
  assertEquals(
    (await ok(path(privateRoom), b.access_token!)).membership,
    'invite',
  );
  const publicSpace = await create(a.access_token!, {
    room_alias_name: 'summary-space',
    preset: 'public_chat',
    creation_content: { type: 'm.space' },
  });
  const publicSummary = await ok(path(publicSpace));
  assertEquals(publicSummary.room_type, 'm.space');
  assertEquals(typeof publicSummary.room_version, 'string');
  assertEquals('membership' in publicSummary, false);
  assertEquals(
    (await ok(path('#summary-space:' + a.home_server), b.access_token!))
      .room_id,
    publicSpace,
  );
  assertEquals(
    (await ok(path(publicSpace), b.access_token!)).membership,
    'leave',
  );
  const allowed = await create(a.access_token!, { preset: 'public_chat' });
  await ok(roomPath(allowed) + '/join', b.access_token!, {});
  const restricted = await create(a.access_token!, {
    room_version: '10',
    initial_state: [{
      type: 'm.room.join_rules',
      content: {
        join_rule: 'restricted',
        allow: [{ type: 'm.room_membership', room_id: allowed }],
      },
    }],
  });
  assertEquals((await ok(path(restricted), b.access_token!)).allowed_room_ids, [
    allowed,
  ]);
  assertEquals((await call(path(restricted))).status, 404);
  await ok(roomPath(allowed) + '/leave', b.access_token!, {});
  assertEquals((await call(path(restricted), b.access_token!)).status, 404);
  const world = await create(a.access_token!, {
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'world_readable' },
    }],
  });
  assertEquals((await ok(path(world))).world_readable, true);
  for (
    const protectedPath of [
      'v1/rooms/' + encodeURIComponent(publicSpace) + '/threads',
      'v1/media/config',
    ]
  ) {
    assertEquals((await call(protectedPath)).status, 401);
  }
  assertEquals((await call(path(publicSpace), 'invalid-token')).status, 401);
});

suite.test('client and federation public directories filter room types before count and pagination', async () => {
  setConfigForTests({ federation: { publicrooms: true } });
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
