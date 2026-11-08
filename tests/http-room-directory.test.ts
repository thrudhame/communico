// doltgres aliases/directory/relations/search/upgrade/user-directory contracts.
import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
const { matrix, registerTestUser, test } = httpSuite(
  'HTTP room directory/search/relations/upgrade',
);
type Json = Record<string, unknown>;
async function call(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'PUT',
  version = 'v3',
) {
  const res = await matrix(
    new Request('http://x/_matrix/client/' + version + '/' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}
const rp = (id: string) => 'rooms/' + encodeURIComponent(id),
  aliasPath = (alias: string) => 'directory/room/' + encodeURIComponent(alias);
async function create(token: string | undefined, body: Json = {}) {
  const res = await call('createRoom', token, body, 'POST');
  assertEquals(res.status, 200, JSON.stringify(res.body));
  return res.body.room_id as string;
}
const state = (id: string, type: string) => rp(id) + '/state/' + type;
async function send(
  id: string,
  token: string | undefined,
  text: string,
  extra: Json = {},
  type = 'm.room.message',
) {
  const res = await call(
    rp(id) + '/send/' + type + '/' + crypto.randomUUID(),
    token,
    { msgtype: 'm.text', body: text, ...extra },
  );
  assertEquals(res.status, 200);
  return res.body.event_id as string;
}

test('aliases: public resolve, Unicode, duplicates/syntax/domain, list access, delete power and canonical repair', async () => {
  const a = await registerTestUser('aliases-a', 'pw'),
    b = await registerTestUser('aliases-b', 'pw'),
    c = await registerTestUser('aliases-c', 'pw');
  const A = a.access_token, B = b.access_token;
  const id = await create(A),
    alias = '#creates:' + a.home_server,
    unicode = '#老虎Â£я🤨👉ඞ:' + a.home_server;
  assertEquals(
    (await call(aliasPath(alias), undefined, { room_id: id })).status,
    401,
  );
  assertEquals((await call(aliasPath(alias), A, { room_id: id })).body, {});
  const resolved = await call(aliasPath(alias));
  assertEquals(resolved.status, 200);
  assertEquals(resolved.body, { room_id: id, servers: [a.home_server] });
  const dup = await call(aliasPath(alias), A, { room_id: id });
  assertEquals([dup.status, dup.body.errcode], [409, 'M_ROOM_IN_USE']);
  for (const bad of ['%invalid:hs1', '#no-domain:', '#foreign:elsewhere']) {
    const res = await call(aliasPath(bad), A, { room_id: id });
    assertEquals([res.status, res.body.errcode], [400, 'M_INVALID_PARAM']);
  }
  assertEquals(
    (await call(aliasPath(unicode), A, { room_id: id })).status,
    200,
  );
  assertEquals((await call(aliasPath(unicode))).body.room_id, id);
  assertEquals(
    (await call(aliasPath('#nope:' + a.home_server))).body.errcode,
    'M_NOT_FOUND',
  );
  assertEquals(
    (await call(aliasPath('#nope:' + a.home_server), A, undefined, 'DELETE'))
      .status,
    404,
  );
  assertEquals(
    ((await call(rp(id) + '/aliases', A)).body.aliases as string[]).length,
    2,
  );
  assertEquals((await call(rp(id) + '/aliases', B)).status, 403);
  const world = await create(A, {
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'world_readable' },
    }],
  });
  assertEquals((await call(rp(world) + '/aliases', B)).status, 200);
  const other = await create(A, { invite: [b.user_id] });
  await call(rp(other) + '/join', B, {}, 'POST');
  const bAlias = '#bobs:' + a.home_server, cAlias = '#carols:' + a.home_server;
  await call(aliasPath(bAlias), B, { room_id: other });
  assertEquals(
    (await call(aliasPath(bAlias), A, undefined, 'DELETE')).status,
    200,
  );
  await call(aliasPath(bAlias), B, { room_id: other });
  assertEquals(
    (await call(aliasPath(bAlias), B, undefined, 'DELETE')).status,
    200,
  );
  await call(aliasPath(cAlias), c.access_token, { room_id: other });
  assertEquals(
    (await call(aliasPath(cAlias), B, undefined, 'DELETE')).status,
    403,
  );
  await call(state(other, 'm.room.power_levels'), A, {
    events: { 'm.room.aliases': 50 },
    users: { [a.user_id]: 100 },
  });
  await call(aliasPath(bAlias), B, { room_id: other });
  assertEquals(
    (await call(aliasPath(bAlias), B, undefined, 'DELETE')).status,
    200,
  );
  const room = await create(A),
    canon = '#okcanon:' + a.home_server,
    alt = '#altok:' + a.home_server;
  for (const value of [canon, alt]) {
    await call(aliasPath(value), A, { room_id: room });
  }
  assertEquals(
    (await call(state(room, 'm.room.canonical_alias'), A, {
      alias: canon,
      alt_aliases: [alt],
    })).status,
    200,
  );
  for (
    const [content, code] of [
      [{ alias: '#missing:' + a.home_server }, 'M_BAD_ALIAS'],
      [{ alias: '%invalid:hs1' }, 'M_INVALID_PARAM'],
      [{ alias }, 'M_BAD_ALIAS'],
      [{ alt_aliases: ['#missing:' + a.home_server] }, 'M_BAD_ALIAS'],
    ] as const
  ) {
    const res = await call(state(room, 'm.room.canonical_alias'), A, content);
    assertEquals([res.status, res.body.errcode], [400, code]);
  }
  assertEquals(
    (await call(aliasPath(canon), A, undefined, 'DELETE')).status,
    200,
  );
  assertEquals((await call(state(room, 'm.room.canonical_alias'), A)).body, {
    alt_aliases: [alt],
  });
});

test('directory: public GET/protected POST, chunk shapes, search, visibility toggles and pagination', async () => {
  const a = await registerTestUser('directory-a', 'pw'),
    b = await registerTestUser('directory-b', 'pw');
  const A = a.access_token;
  const id = await create(A, {
    visibility: 'public',
    name: 'Test Name',
    topic: 'Test Topic Wombles',
    room_alias_name: 'dir-pub',
  });
  const listed = await call('publicRooms');
  assertEquals(listed.status, 200);
  const chunk = (listed.body.chunk as Json[]).find((c) => c.room_id === id)!;
  assertEquals(chunk, {
    room_id: id,
    name: 'Test Name',
    topic: 'Test Topic Wombles',
    canonical_alias: '#dir-pub:' + a.home_server,
    num_joined_members: 1,
    world_readable: false,
    guest_can_join: false,
    join_rule: 'public',
  });
  const bare = await create(A, { visibility: 'public' });
  const empty = ((await call('publicRooms')).body.chunk as Json[]).find((c) =>
    c.room_id === bare
  )!;
  for (const key of ['name', 'topic', 'canonical_alias']) {
    assertEquals(key in empty, false);
  }
  for (const needle of ['wombles', 'DIR-PUB']) {
    const res = await call('publicRooms', A, {
      filter: { generic_search_term: needle },
    }, 'POST');
    assertEquals((res.body.chunk as Json[]).map((c) => c.room_id), [id]);
  }
  assertEquals((await call('publicRooms', undefined, {}, 'POST')).status, 401);
  const path = 'directory/list/room/' + encodeURIComponent(id);
  assertEquals((await call(path)).body.visibility, 'public');
  await call(path, A, { visibility: 'private' });
  assertEquals((await call(path)).body.visibility, 'private');
  assert(
    !(await call('publicRooms')).body.chunk ||
      !((await call('publicRooms')).body.chunk as Json[]).some((c) =>
        c.room_id === id
      ),
  );
  await call(path, A, { visibility: 'public' });
  assert(
    ((await call('publicRooms')).body.chunk as Json[]).some((c) =>
      c.room_id === id
    ),
  );
  assertEquals(
    (await call(path, undefined, { visibility: 'private' })).status,
    401,
  );
  assertEquals(
    (await call(path, b.access_token, { visibility: 'private' })).status,
    403,
  );
  assertEquals((await call(path, A, { visibility: 'nope' })).status, 400);
  assertEquals(
    (await call('directory/list/room/!nope:' + a.home_server)).status,
    404,
  );
  const page = await call('publicRooms?limit=1');
  assert(typeof page.body.next_batch === 'string');
  assertEquals(
    (await call('publicRooms?limit=1&since=' + page.body.next_batch)).body
      .prev_batch,
    '0',
  );
});

test('relations: all three paths, direction/type paging, thread list and one-level bundled latest event', async () => {
  const a = await registerTestUser('relations-a', 'pw'),
    b = await registerTestUser('relations-b', 'pw');
  const A = a.access_token;
  const id = await create(A, { preset: 'public_chat' });
  await call(rp(id) + '/join', b.access_token, {}, 'POST');
  const root = await send(id, A, 'root'),
    thread = (text: string, token = A) =>
      send(id, token, text, {
        'm.relates_to': { rel_type: 'm.thread', event_id: root },
      });
  const one = await thread('one'), two = await thread('two', b.access_token);
  await send(id, A, 'reaction', {
    'm.relates_to': { rel_type: 'm.annotation', event_id: root, key: '👍' },
  }, 'm.reaction');
  const path = rp(id) + '/relations/' + encodeURIComponent(root);
  assertEquals(
    ((await call(path, A, undefined, 'GET', 'v1')).body.chunk as Json[]).length,
    3,
  );
  const all = await call(
    path + '/m.thread/m.room.message?dir=f',
    A,
    undefined,
    'GET',
    'v1',
  );
  assertEquals((all.body.chunk as Json[]).map((e) => e.event_id), [one, two]);
  const page = await call(
    path + '/m.thread?limit=1',
    A,
    undefined,
    'GET',
    'v1',
  );
  assertEquals((page.body.chunk as Json[])[0].event_id, two);
  assert(typeof page.body.next_batch === 'string');
  assertEquals(
    ((await call(
      path + '/m.thread?limit=1&from=' + page.body.next_batch,
      A,
      undefined,
      'GET',
      'v1',
    )).body.chunk as Json[])[0].event_id,
    one,
  );
  const event = await call(rp(id) + '/event/' + encodeURIComponent(root), A),
    bundle = ((event.body.unsigned as Json)['m.relations'] as Json)[
      'm.thread'
    ] as Json;
  assertEquals(bundle.count, 2);
  assertEquals(bundle.current_user_participated, true);
  assertEquals((bundle.latest_event as Json).event_id, two);
  assertEquals(
    ((bundle.latest_event as Json).unsigned as Json)['m.relations'],
    undefined,
  );
  const threads = await call(
    rp(id) + '/threads?include=participated',
    b.access_token,
    undefined,
    'GET',
    'v1',
  );
  assertEquals((threads.body.chunk as Json[]).map((e) => e.event_id), [root]);
  assertEquals(
    (await call(path + '?dir=x', A, undefined, 'GET', 'v1')).status,
    400,
  );
  assertEquals(
    (await call(rp(id) + '/threads?include=bad', A, undefined, 'GET', 'v1'))
      .status,
    400,
  );
  assertEquals(
    (await call(rp(id) + '/relations/$missing', A, undefined, 'GET', 'v1'))
      .status,
    404,
  );
});

test('search: auth/body errors, matching/rank/recent pages, filters, context/profile, state/groupings, redaction and joined scope', async () => {
  const a = await registerTestUser('search-a', 'pw'),
    b = await registerTestUser('search-b', 'pw');
  const A = a.access_token;
  const id = await create(A, { preset: 'public_chat' });
  const first = await send(id, A, 'wombles alpha'),
    second = await send(id, A, 'wombles wombles'),
    last = await send(id, A, 'wombles newest', { url: 'https://example.test' });
  const search = async (req: Json, token = A, next = '') => {
    const res = await call('search' + next, token, {
      search_categories: { room_events: { search_term: 'wombles', ...req } },
    }, 'POST');
    return {
      status: res.status,
      body: (res.body.search_categories as Json)?.room_events as Json,
    };
  };
  assertEquals((await call('search', undefined, {}, 'POST')).status, 401);
  for (
    const body of [{}, { search_categories: {} }, {
      search_categories: { room_events: { search_term: 4 } },
    }]
  ) {
    assertEquals(
      (await call('search', A, body, 'POST')).body.errcode,
      'M_BAD_JSON',
    );
  }
  assertEquals(
    (await call('search', A, {
      search_categories: {
        room_events: { search_term: 'x', order_by: 'nope' },
      },
    }, 'POST')).body.errcode,
    'M_INVALID_PARAM',
  );
  const ranked = await search({});
  assertEquals(ranked.status, 200);
  assertEquals(ranked.body.count, 3);
  assertEquals(ranked.body.highlights, ['wombles']);
  assertEquals(
    ((ranked.body.results as Json[])[0].result as Json).event_id,
    second,
  );
  const recent = await search({
    order_by: 'recent',
    filter: { limit: 1 },
    include_state: true,
    event_context: { before_limit: 1, after_limit: 1, include_profile: true },
    groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
  });
  assertEquals(
    ((recent.body.results as Json[])[0].result as Json).event_id,
    last,
  );
  assert(typeof recent.body.next_batch === 'string');
  assert(id in (recent.body.state as Json));
  assert('room_id' in (recent.body.groups as Json));
  const ctx = (recent.body.results as Json[])[0].context as Json;
  assert(a.user_id in (ctx.profile_info as Json));
  const next = await search(
    { order_by: 'recent', filter: { limit: 1 } },
    A,
    '?next_batch=' + recent.body.next_batch,
  );
  assertEquals(
    ((next.body.results as Json[])[0].result as Json).event_id,
    second,
  );
  assertEquals(
    (await search({ filter: { contains_url: true } })).body.count,
    1,
  );
  assertEquals((await search({ filter: { not_rooms: [id] } })).body.count, 0);
  assertEquals((await search({}, b.access_token)).body.count, 0);
  await call(
    rp(id) + '/redact/' + encodeURIComponent(first) + '/red',
    A,
    {},
    'PUT',
  );
  assertEquals((await search({})).body.count, 2);
  assertEquals(
    (await call('search?next_batch=bad', A, {
      search_categories: { room_events: { search_term: 'x' } },
    }, 'POST')).body.errcode,
    'M_INVALID_PARAM',
  );
});

test('user directory: global profile names, shared/public rooms, self exclusion and limits', async () => {
  const a = await registerTestUser('users-a', 'pw'),
    b = await registerTestUser('users-b', 'pw'),
    c = await registerTestUser('users-c', 'pw');
  const A = a.access_token;
  await call(
    'profile/' + encodeURIComponent(b.user_id) + '/displayname',
    b.access_token,
    { displayname: 'Global Wombles' },
  );
  const id = await create(b.access_token, { preset: 'public_chat' });
  await call(
    state(id, 'm.room.member') + '/' + encodeURIComponent(b.user_id),
    b.access_token,
    { membership: 'join', displayname: 'Private Room Name' },
  );
  const query = (term: string, limit = 10) =>
    call('user_directory/search', A, { search_term: term, limit }, 'POST');
  const found = await query('global womb');
  assertEquals((found.body.results as Json[]).map((u) => u.user_id), [
    b.user_id,
  ]);
  assertEquals(
    (found.body.results as Json[])[0].display_name,
    'Global Wombles',
  );
  assertEquals((await query('Private Room Name')).body.results, []);
  assertEquals((await query('users-a')).body.results, []);
  const privateRoom = await create(A, { invite: [c.user_id] });
  await call(rp(privateRoom) + '/join', c.access_token, {}, 'POST');
  assertEquals((await query('users-c')).body.results, [{
    user_id: c.user_id,
    display_name: 'users-c',
  }]);
  assertEquals((await query('users-', 1)).body.limited, true);
  assertEquals(
    (await call('user_directory/search', A, {}, 'POST')).body.errcode,
    'M_MISSING_PARAM',
  );
});

test('upgrade: six creator/PL cases, v10/11/12 predecessor+tombstone, alias move, permission/version errors, rule migration', async () => {
  const a = await registerTestUser('upgrade-a', 'pw'),
    b = await registerTestUser('upgrade-b', 'pw'),
    c = await registerTestUser('upgrade-c', 'pw');
  const A = a.access_token!, B = b.access_token!, C = c.access_token!;
  const cases = [
    {
      version: '11',
      users: { [b.user_id]: 100 },
      token: B,
      creators: [],
      want: {},
    },
    {
      version: '11',
      users: { [b.user_id]: 100, [c.user_id]: 100 },
      token: B,
      creators: [],
      want: { [c.user_id]: 100 },
    },
    {
      version: '12',
      users: { [b.user_id]: 150 },
      token: B,
      creators: [c.user_id],
      want: {},
    },
    {
      version: '12',
      users: { [b.user_id]: 150, [c.user_id]: 50 },
      token: B,
      creators: [c.user_id],
      want: {},
    },
    {
      version: '11',
      users: { [a.user_id]: 100, [b.user_id]: 100 },
      token: A,
      creators: [b.user_id],
      want: {},
    },
    {
      version: '11',
      users: { [a.user_id]: 100, [b.user_id]: 100, [c.user_id]: 50 },
      token: A,
      creators: [b.user_id],
      want: { [c.user_id]: 50 },
    },
  ];
  for (const tc of cases) {
    const id = await create(A, {
      room_version: tc.version,
      invite: [b.user_id, c.user_id],
    });
    await call(rp(id) + '/join', B, {}, 'POST');
    await call(rp(id) + '/join', C, {}, 'POST');
    assertEquals(
      (await call(state(id, 'm.room.power_levels'), A, { users: tc.users }))
        .status,
      200,
    );
    const res = await call(rp(id) + '/upgrade', tc.token, {
      new_version: '12',
      additional_creators: tc.creators,
    }, 'POST');
    assertEquals(res.status, 200, JSON.stringify(res.body));
    const next = res.body.replacement_room as string;
    assertEquals(
      (await call(state(next, 'm.room.power_levels'), tc.token)).body.users,
      tc.want,
    );
    const createEvent = await call(state(next, 'm.room.create'), tc.token);
    assertEquals(
      createEvent.body.additional_creators,
      tc.creators.length > 0 ? tc.creators : undefined,
    );
  }
  for (const version of ['10', '11', '12']) {
    const id = await create(A, { room_version: version });
    const res = await call(
      rp(id) + '/upgrade',
      A,
      { new_version: '12' },
      'POST',
    );
    assertEquals(res.status, 200);
    const next = res.body.replacement_room as string;
    const event = await call(state(next, 'm.room.create') + '?format=event', A);
    assertEquals(next, '!' + String(event.body.event_id).slice(1));
    const pred = (event.body.content as Json).predecessor as Json;
    assertEquals(pred, { room_id: id });
    assertEquals(
      (await call(state(id, 'm.room.tombstone'), A)).body.replacement_room,
      next,
    );
  }
  const old = await create(A, { room_alias_name: 'upgrade-src' }),
    alias = '#upgrade-src:' + a.home_server;
  await call('pushrules/global/room/' + encodeURIComponent(old), A, {
    actions: ['dont_notify'],
  });
  const upgraded = await call(
    rp(old) + '/upgrade',
    A,
    { new_version: '12' },
    'POST',
  );
  assertEquals(upgraded.status, 200);
  const next = upgraded.body.replacement_room as string;
  assertEquals((await call(aliasPath(alias))).body.room_id, next);
  assertEquals(
    (await call(state(next, 'm.room.canonical_alias'), A)).body.alias,
    alias,
  );
  assertEquals(
    (await call('pushrules/global/room/' + encodeURIComponent(next), A)).status,
    200,
  );
  assertEquals(
    (await call('pushrules/global/room/' + encodeURIComponent(old), A)).status,
    200,
  );
  const low = await create(A, { invite: [c.user_id] });
  await call(rp(low) + '/join', C, {}, 'POST');
  assertEquals(
    (await call(rp(low) + '/upgrade', C, { new_version: '12' }, 'POST')).status,
    403,
  );
  assertEquals(
    (await call(rp(low) + '/upgrade', A, { new_version: '99' }, 'POST')).body
      .errcode,
    'M_UNSUPPORTED_ROOM_VERSION',
  );
  assertEquals(
    (await call(rp(low) + '/upgrade', A, {}, 'POST')).body.errcode,
    'M_MISSING_PARAM',
  );
  const manual = await create(A);
  await call('pushrules/global/room/' + encodeURIComponent(manual), A, {
    actions: ['dont_notify'],
  });
  const replacement = await create(A, {
    creation_content: { predecessor: { room_id: manual } },
  });
  assertEquals(
    (await call('pushrules/global/room/' + encodeURIComponent(replacement), A))
      .status,
    200,
  );
  await call(
    'pushrules/global/room/' + encodeURIComponent(replacement),
    A,
    undefined,
    'DELETE',
  );
  await send(replacement, A, 'later traffic');
  assertEquals(
    (await call('pushrules/global/room/' + encodeURIComponent(replacement), A))
      .status,
    404,
    'ordinary traffic does not replay migrations',
  );
});
