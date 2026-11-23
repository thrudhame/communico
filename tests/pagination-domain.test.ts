import { assert, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP pagination publication domains');
async function call(
  path: string,
  access: string,
  body?: unknown,
  method?: string,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + access },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function fixture(name: string) {
  const a = await suite.registerTestUser(name + '-a', 'pw');
  const b = await suite.registerTestUser(name + '-b', 'pw');
  const created = await call('v3/createRoom', a.access_token!, {
    invite: [b.user_id],
  });
  assertEquals(created.status, 200);
  const room = encodeURIComponent(String(created.body.room_id));
  await call('v3/rooms/' + room + '/join', b.access_token!, {});
  let root = '';
  for (let i = 0; i < 5; i++) {
    const sent = await call(
      'v3/rooms/' + room + '/send/m.room.message/' + i,
      a.access_token!,
      {
        msgtype: 'm.text',
        body: 'paginationneedle ' + i,
        ...(i === 0
          ? {}
          : { 'm.relates_to': { rel_type: 'm.thread', event_id: root } }),
      },
      'PUT',
    );
    assertEquals(sent.status, 200);
    if (i === 0) root = String(sent.body.event_id);
  }
  await call('v3/sync', a.access_token!);
  return { access: b.access_token!, room, root: encodeURIComponent(root) };
}
async function continuation(
  token: unknown,
  follow: (token: string) => ReturnType<typeof call>,
) {
  assert(typeof token === 'string' && token.length > 0);
  assertEquals((await follow(token)).status, 200, 'same-owner continuation');
  const db = theApp().server;
  const [identity] = await db.query(
    'SELECT * FROM publication_domain WHERE singleton=1',
  );
  await db.execute('UPDATE publication_domain SET domain=? WHERE singleton=1', [
    crypto.randomUUID(),
  ]);
  try {
    const foreign = await follow(token);
    assertEquals(
      foreign.status,
      400,
      'equal numeric cuts in another domain must not select a page',
    );
    assertEquals(foreign.body.errcode, 'M_INVALID_PARAM');
  } finally {
    await db.execute(
      'UPDATE publication_domain SET domain=? WHERE singleton=1',
      [identity.domain],
    );
  }
  assert(token.startsWith('v1.'), 'issued continuation must carry its domain');
  const envelope = JSON.parse(
    Buffer.from(token.slice(3), 'base64url').toString(),
  );
  assertEquals(envelope[0], identity.domain);
  const legacy = String(envelope[1]);
  assertEquals(
    (await follow(legacy)).status,
    200,
    'original home legacy binding',
  );
  await db.execute(
    "UPDATE publication_domain SET node='facade-a' WHERE singleton=1",
  );
  try {
    assertEquals(
      (await follow(legacy)).status,
      400,
      'facade cannot inherit unbound continuations',
    );
    assertEquals(
      (await follow(token)).status,
      200,
      'facade retains its bound local continuation',
    );
  } finally {
    await db.execute('UPDATE publication_domain SET node=? WHERE singleton=1', [
      identity.node,
    ]);
  }
}

suite.test('segment messages, context, members and limited ordinary sync bind the room cursor', async () => {
  const f = await fixture('page-segment');
  const path = 'v3/rooms/' + f.room;
  const page = await call(path + '/messages?dir=b&limit=1', f.access);
  assertEquals(page.status, 200);
  await continuation(
    page.body.end,
    (token) => call(path + '/messages?dir=b&from=' + token, f.access),
  );
  const context = await call(
    path + '/context/' + f.root + '?limit=2',
    f.access,
  );
  assertEquals(context.status, 200);
  await continuation(
    context.body.end,
    (token) => call(path + '/members?at=' + token, f.access),
  );
  const sync = await call(
    'v3/sync?filter=' +
      encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } })),
    f.access,
  );
  assertEquals(sync.status, 200);
  const joined = (sync.body.rooms as Json).join as Json;
  const timeline = (joined[decodeURIComponent(f.room)] as Json)
    .timeline as Json;
  await continuation(
    timeline.prev_batch,
    (token) => call(path + '/messages?dir=b&from=' + token, f.access),
  );
});

suite.test('relations retain the room-scoped causal boundary inside the domain', async () => {
  const f = await fixture('page-relation');
  const path = 'v1/rooms/' + f.room + '/relations/' + f.root + '?limit=1';
  const page = await call(path, f.access);
  assertEquals(page.status, 200);
  await continuation(
    page.body.next_batch,
    (token) => call(path + '&from=' + token, f.access),
  );
});

suite.test('search global and group keysets retain their own domain, order and scope', async () => {
  const f = await fixture('page-search');
  const body = {
    search_categories: {
      room_events: {
        search_term: 'paginationneedle',
        order_by: 'recent',
        filter: { limit: 1 },
        groupings: { group_by: [{ key: 'room_id' }] },
      },
    },
  };
  const page = await call('v3/search', f.access, body);
  assertEquals(page.status, 200);
  const result = (page.body.search_categories as Json).room_events as Json;
  const follow = (token: string) =>
    call('v3/search?next_batch=' + token, f.access, body);
  await continuation(result.next_batch, follow);
  const grouped = ((result.groups as Json).room_id as Json)[
    decodeURIComponent(f.room)
  ] as Json;
  await continuation(grouped.next_batch, follow);
});

suite.test('notification saved-sequence continuation refuses foreign collisions', async () => {
  const f = await fixture('page-notification');
  const path = 'v3/notifications?limit=1';
  const page = await call(path, f.access);
  assertEquals(page.status, 200);
  await continuation(
    page.body.next_token,
    (token) => call(path + '&from=' + token, f.access),
  );
});

suite.test('local public-directory offsets never alias another publication domain', async () => {
  const user = await suite.registerTestUser('page-directory', 'pw');
  for (let i = 0; i < 2; i++) {
    const created = await call('v3/createRoom', user.access_token!, {
      visibility: 'public',
    });
    assertEquals(created.status, 200);
  }
  const page = await call('v3/publicRooms?limit=1', user.access_token!);
  assertEquals(page.status, 200);
  await continuation(
    page.body.next_batch,
    (token) =>
      call('v3/publicRooms?limit=1&since=' + token, user.access_token!),
  );
});

suite.test('hierarchy session cursors keep the retained traversal inside its domain', async () => {
  const user = await suite.registerTestUser('page-hierarchy', 'pw');
  const created = await call('v3/createRoom', user.access_token!, {
    creation_content: { type: 'm.space' },
  });
  const child = await call('v3/createRoom', user.access_token!, {});
  assertEquals(created.status, 200);
  assertEquals(child.status, 200);
  const room = encodeURIComponent(String(created.body.room_id));
  const state = await call(
    'v3/rooms/' + room + '/state/m.space.child/' +
      encodeURIComponent(String(child.body.room_id)),
    user.access_token!,
    { via: [theApp().tenant.serverName] },
    'PUT',
  );
  assertEquals(state.status, 200);
  const path = 'v1/rooms/' + room + '/hierarchy?limit=1';
  const page = await call(path, user.access_token!);
  assertEquals(page.status, 200);
  await continuation(
    page.body.next_batch,
    (token) => call(path + '&from=' + token, user.access_token!),
  );
});
