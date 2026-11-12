// doltgres federation-endpoints and room-route method inventory, real HTTP.
import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { setAvatarUrl, setDisplayName } from '#engine/tenant/users.ts';
import { seedServer } from './federation/doc-helper.ts';
import { startFakeServer } from './federation/fake-server.ts';
import {
  fedCaller,
  type Json,
  remoteServer,
  signTemplate,
} from './http-federation.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { httpSuite } from './http-app.ts';

// Identifiers split at their first colon: the server name can carry a port.
const self = 'localhost:18449';
const reset = () => setConfigForTests({ server: { name: self } });
reset();
const { matrix, registerTestUser, test } = httpSuite('HTTP federation queries');
const enc = encodeURIComponent;
const fed = '/_matrix/federation/v1/';
let call: ReturnType<typeof fedCaller>;
let token: string;
let room: string;
let alias: string;
async function client(
  path: string,
  body?: Json,
  method = 'GET',
  auth?: string,
) {
  const response = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: auth === undefined ? {} : { authorization: 'Bearer ' + auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

test('query/profile: local fields, unset nulls, malformed/domain 400, unknown 404', async () => {
  call = fedCaller(matrix, await remoteServer());
  const alice = await registerTestUser('query-alice', 'pw');
  token = alice.access_token!;
  await setAvatarUrl(theApp().tenant, 'query-alice', 'mxc://localhost/avatar');
  const path = fed + 'query/profile?user_id=' + enc(alice.user_id);
  assertEquals(await call('GET', path), {
    status: 200,
    body: { displayname: 'query-alice', avatar_url: 'mxc://localhost/avatar' },
  });
  assertEquals((await call('GET', path + '&field=displayname')).body, {
    displayname: 'query-alice',
  });
  assertEquals((await call('GET', path + '&field=avatar_url')).body, {
    avatar_url: 'mxc://localhost/avatar',
  });
  assertEquals((await call('GET', path + '&field=other')).status, 400);
  for (const id of ['', 'bad', '@alice:else.test', '@alice:localhost:http']) {
    const result = await call('GET', fed + 'query/profile?user_id=' + enc(id));
    assertEquals([result.status, result.body.errcode], [
      400,
      'M_INVALID_PARAM',
    ]);
  }
  assertEquals((await call('GET', fed + 'query/profile')).status, 400);
  const unknown = await call(
    'GET',
    fed + 'query/profile?user_id=' + enc('@unknown:' + self),
  );
  assertEquals([unknown.status, unknown.body.errcode], [404, 'M_NOT_FOUND']);
  await setDisplayName(theApp().tenant, 'query-alice', null);
  await setAvatarUrl(theApp().tenant, 'query-alice', null);
  assertEquals((await call('GET', path)).body, {});
  assertEquals((await call('GET', path + '&field=displayname')).body, {
    displayname: null,
  });
  assertEquals((await call('GET', path + '&field=avatar_url')).body, {
    avatar_url: null,
  });
  // The public C-S profile readers share the same identifier handling.
  for (const suffix of ['', '/displayname', '/avatar_url']) {
    assertEquals(await client('profile/' + enc(alice.user_id) + suffix), {
      status: 200,
      body: {},
    });
  }
});

test('query/directory: raw Unicode URI, aliases with server port, local validation and unknown', async () => {
  const localpart = 'caf\u00e9-query';
  const created = await client(
    'createRoom',
    {
      room_alias_name: 'query-alpha',
      name: 'Published Alpha',
      visibility: 'public',
    },
    'POST',
    token,
  );
  assertEquals(created.status, 200);
  room = created.body.room_id as string;
  alias = '#' + localpart + ':' + self;
  assertEquals(
    (await client(
      'directory/room/' + enc(alias),
      { room_id: room },
      'PUT',
      token,
    )).status,
    200,
  );
  const answer = await call(
    'GET',
    fed + 'query/directory?room_alias=' + enc(alias),
  );
  assertEquals(answer, {
    status: 200,
    body: { room_id: room, servers: [self] },
  });
  for (const value of [undefined, '#x:else.test']) {
    const bad = await call(
      'GET',
      fed + 'query/directory' +
        (value === undefined ? '' : '?room_alias=' + enc(value)),
    );
    assertEquals([bad.status, bad.body.errcode], [400, 'M_INVALID_PARAM']);
  }
  const unknown = await call(
    'GET',
    fed + 'query/directory?room_alias=' + enc('#missing:' + self),
  );
  assertEquals([unknown.status, unknown.body.errcode], [404, 'M_NOT_FOUND']);
  const second = '#created-by-client:' + self;
  assertEquals(
    (await client(
      'directory/room/' + enc(second),
      { room_id: room },
      'PUT',
      token,
    )).status,
    200,
  );
  assertEquals(
    (await call('GET', fed + 'query/directory?room_alias=' + enc(second))).body,
    { room_id: room, servers: [self] },
  );
});

test('publicRooms: signed GET/POST, search, pagination and truthful network selection', async () => {
  setConfigForTests({
    server: { name: self },
    federation: { publicrooms: true },
  });
  assertEquals(
    (await client(
      'createRoom',
      { name: 'Published Beta', visibility: 'public' },
      'POST',
      token,
    )).status,
    200,
  );
  const target = fed + 'publicRooms';
  const get = await call('GET', target + '?limit=1&include_all_networks=true');
  assertEquals(get.status, 200);
  assertEquals((get.body.chunk as Json[]).length, 1);
  assertEquals(get.body.total_room_count_estimate, 2);
  assertEquals(get.body.next_batch, '1');
  const next = await call('GET', target + '?limit=1&since=1');
  assertEquals((next.body.chunk as Json[]).length, 1);
  assertEquals(next.body.prev_batch, '0');
  const post = await call('POST', target, {
    filter: { generic_search_term: 'Alpha' },
    include_all_networks: true,
  });
  assertEquals(post.status, 200);
  assertEquals((post.body.chunk as Json[]).map((r) => r.room_id), [room]);
  assertEquals((post.body.chunk as Json[])[0].name, 'Published Alpha');
  const bridge = await call('POST', target, {
    third_party_instance_id: 'unknown',
  });
  assertEquals(bridge.body, { chunk: [], total_room_count_estimate: 0 });
  assertEquals(
    (await call('POST', target, {
      include_all_networks: true,
      third_party_instance_id: 'unknown',
    })).status,
    400,
  );
});

test('known-only remote profiles: held members, field shapes and no outbound proxy', async () => {
  setConfigForTests({
    server: { name: self },
    federation: { lookups: 'known' },
  });
  const fake = await startFakeServer({
    ourKeyDoc: async () => {
      const response = await matrix(
        new Request('http://x/_matrix/key/v2/server'),
      );
      return await response.json();
    },
  });
  try {
    await seedServer(theApp().server, fake);
    const user = '@remote:' + fake.name;
    const profilePath = 'profile/' + enc(user);
    for (const suffix of ['', '/displayname', '/avatar_url']) {
      assertEquals((await client(profilePath + suffix)).status, 404);
    }
    assertEquals(
      (await client('directory/room/' + enc('#unknown:' + fake.name))).status,
      404,
    );
    const remoteCall = fedCaller(matrix, fake);
    const created = await client(
      'createRoom',
      { preset: 'public_chat' },
      'POST',
      token,
    );
    assertEquals(created.status, 200);
    const id = created.body.room_id as string;
    const mk = await remoteCall(
      'GET',
      fed + 'make_join/' + enc(id) + '/' + enc(user) + '?ver=11',
    );
    assertEquals(mk.status, 200);
    const pdu = await signTemplate({
      ...mk.body.event as Json,
      content: {
        membership: 'join',
        displayname: 'Remote profile',
        avatar_url: 'mxc://remote/avatar',
      },
    }, fake);
    assertEquals(
      (await remoteCall(
        'PUT',
        '/_matrix/federation/v2/send_join/' + enc(id) + '/' +
          enc(String(pdu.event_id)),
        toWire(pdu, '11'),
      )).status,
      200,
    );
    assertEquals(await client(profilePath), {
      status: 200,
      body: {
        displayname: 'Remote profile',
        avatar_url: 'mxc://remote/avatar',
      },
    });
    assertEquals((await client(profilePath + '/displayname')).body, {
      displayname: 'Remote profile',
    });
    assertEquals((await client(profilePath + '/avatar_url')).body, {
      avatar_url: 'mxc://remote/avatar',
    });
    for (const federation of [{ lookups: 'none' }, { enabled: false }]) {
      setConfigForTests({ server: { name: self }, federation });
      for (const suffix of ['', '/displayname', '/avatar_url']) {
        assertEquals((await client(profilePath + suffix)).status, 404);
      }
      reset();
    }
    assertEquals(
      fake.requests.length,
      0,
      'public reads must not dial a remote server',
    );
  } finally {
    reset();
    await fake.close();
  }
});

test('full restored federation route inventory: authentication and wrong methods', async () => {
  const routes: [string, string][] = [
    ['PUT', 'v1/send/txn'],
    ['GET', 'v1/make_join/!r:x/@u:x'],
    ['PUT', 'v1/send_join/!r:x/$e'],
    ['PUT', 'v2/send_join/!r:x/$e'],
    ['GET', 'v1/make_leave/!r:x/@u:x'],
    ['PUT', 'v1/send_leave/!r:x/$e'],
    ['PUT', 'v2/send_leave/!r:x/$e'],
    ['PUT', 'v2/invite/!r:x/$e'],
    ['GET', 'v1/state/!r:x'],
    ['GET', 'v1/state_ids/!r:x'],
    ['GET', 'v1/event/$e'],
    ['GET', 'v1/event_auth/!r:x/$e'],
    ['GET', 'v1/backfill/!r:x'],
    ['POST', 'v1/get_missing_events/!r:x'],
    ['GET', 'v1/query/profile'],
    ['GET', 'v1/query/directory'],
    ['GET', 'v1/publicRooms'],
    ['POST', 'v1/publicRooms'],
  ];
  for (const [method, path] of routes) {
    const target = '/_matrix/federation/' + path;
    const response = await matrix(
      new Request('http://x' + target, {
        method,
        body: method === 'GET' ? undefined : '{}',
      }),
    );
    assertEquals(response.status, 401, method + ' ' + path);
    assertEquals((await response.json()).errcode, 'M_UNAUTHORIZED');
    const wrong = path === 'v1/publicRooms'
      ? 'PUT'
      : method === 'GET'
      ? 'POST'
      : 'GET';
    const result = await call(wrong, target, wrong === 'GET' ? undefined : {});
    assertEquals(
      [result.status, result.body.errcode],
      [405, 'M_UNRECOGNIZED'],
      target,
    );
  }
  assertEquals((await call('PUT', fed + 'version', {})).status, 405);
});
