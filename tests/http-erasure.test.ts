import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { requireRoom } from '#engine/client/room.ts';

const suite = httpSuite('HTTP local account erasure');
type Json = Record<string, unknown>;
async function call(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
suite.test('erase prunes newcomers across event, state, context, search and bundles but retains prior shared/public visibility and stored originals', async () => {
  const alice = await suite.registerTestUser('erase-a', 'pw');
  const bob = await suite.registerTestUser('erase-b', 'pw');
  const carol = await suite.registerTestUser('erase-c', 'pw');
  const dave = await suite.registerTestUser('erase-d', 'pw');
  const a = alice.access_token!,
    b = bob.access_token!,
    c = carol.access_token!,
    d = dave.access_token!;
  const made = await call('/createRoom', a, 'POST', { preset: 'public_chat' });
  const roomId = String(made.body.room_id),
    roomPath = '/rooms/' + encodeURIComponent(roomId);
  await call(roomPath + '/join', b, 'POST', {});
  const message = await call(roomPath + '/send/m.room.message/root', a, 'PUT', {
    msgtype: 'm.text',
    body: 'erase-secret',
  });
  const root = String(message.body.event_id);
  await call(roomPath + '/send/m.room.message/thread', a, 'PUT', {
    msgtype: 'm.text',
    body: 'erase-reply',
    'm.relates_to': { rel_type: 'm.thread', event_id: root },
  });
  const first = await call(roomPath + '/state/m.room.topic', a, 'PUT', {
    topic: 'erase-old-topic',
  });
  const second = await call(roomPath + '/state/m.room.topic', a, 'PUT', {
    topic: 'public-new-topic',
  });
  // Carol was not joined at the event but had shared-history visibility before erasure.
  await call(roomPath + '/join', c, 'POST', {});
  const world = await call('/createRoom', a, 'POST', {
    preset: 'public_chat',
    initial_state: [{
      type: 'm.room.history_visibility',
      state_key: '',
      content: { history_visibility: 'world_readable' },
    }],
  });
  const worldId = String(world.body.room_id);
  const worldMessage = await call(
    '/rooms/' + encodeURIComponent(worldId) + '/send/m.room.message/public',
    a,
    'PUT',
    { msgtype: 'm.text', body: 'public-before-erasure' },
  );
  const accountPath = '/user/' + encodeURIComponent(alice.user_id) +
    '/account_data/org.example.private';
  await call(accountPath, a, 'PUT', { secret: true });
  const stored = await requireRoom(roomId);
  const before = await stored.tx((tx) => tx.events.get(root));
  const result = await call('/account/deactivate', a, 'POST', {
    erase: true,
    auth: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: alice.user_id },
      password: 'pw',
    },
  });
  assertEquals(result.status, 200);
  await call(roomPath + '/join', d, 'POST', {});
  const eventPath = roomPath + '/event/' + encodeURIComponent(root);
  for (const token of [b, c]) {
    assertEquals((await call(eventPath, token)).body.content, {
      msgtype: 'm.text',
      body: 'erase-secret',
    });
  }
  const erased = await call(eventPath, d);
  assertEquals(erased.status, 200);
  assertEquals(erased.body.content, {});
  const bundles =
    ((erased.body.unsigned as Json)['m.relations'] as Json)['m.thread'] as Json;
  assertEquals((bundles.latest_event as Json).content, {});
  const stateEvent = await call(
    roomPath + '/event/' + encodeURIComponent(String(second.body.event_id)),
    d,
  );
  assertEquals((stateEvent.body.unsigned as Json).prev_content, {});
  assertEquals(
    (await call(
      roomPath + '/event/' + encodeURIComponent(String(first.body.event_id)),
      d,
    )).body.content,
    {},
  );
  const context = await call(
    roomPath + '/context/' + encodeURIComponent(root),
    d,
  );
  assertEquals((context.body.event as Json).content, {});
  assertEquals((await call(roomPath + '/state/m.room.topic', d)).body, {});
  assertEquals((await call(roomPath + '/state/m.room.topic', c)).body, {
    topic: 'public-new-topic',
  });
  const history = await call(roomPath + '/messages?dir=b&limit=100', d);
  assertEquals(
    (history.body.chunk as Json[]).find((event) => event.event_id === root)
      ?.content,
    {},
  );
  const sync = await call('/sync', d);
  const joined = ((sync.body.rooms as Json).join as Json)[roomId] as Json;
  assertEquals(
    ((joined.timeline as Json).events as Json[]).find((event) =>
      event.event_id === root
    )?.content,
    {},
  );
  const search = await call('/search', d, 'POST', {
    search_categories: { room_events: { search_term: 'erase-secret' } },
  });
  const category = (search.body.search_categories as Json).room_events as Json;
  assertEquals(category.count, 0);
  assertEquals(category.results, []);
  await call(roomPath + '/send/m.room.message/safe-result', b, 'PUT', {
    msgtype: 'm.text',
    body: 'safe-result',
  });
  for (
    const [token, expected] of [[d, {}], [c, {
      displayname: 'erase-a',
    }]] as const
  ) {
    const response = await call('/search', token, 'POST', {
      search_categories: {
        room_events: {
          search_term: 'safe-result',
          filter: { rooms: [roomId] },
          event_context: {
            before_limit: 100,
            after_limit: 0,
            include_profile: true,
          },
        },
      },
    });
    const result =
      (((response.body.search_categories as Json).room_events as Json)
        .results as Json[])[0];
    assert(result);
    assertEquals(
      ((result.context as Json).profile_info as Json)[alice.user_id],
      expected,
    );
  }
  assertEquals(
    (await call(
      '/rooms/' + encodeURIComponent(worldId) + '/event/' +
        encodeURIComponent(String(worldMessage.body.event_id)),
      d,
    )).body.content,
    { msgtype: 'm.text', body: 'public-before-erasure' },
  );
  assertEquals(await stored.tx((tx) => tx.events.get(root)), before);
  const tenantData = await theApp().tenant.tx((tx) =>
    tx.accountData.get('erase-a', '', 'org.example.private')
  );
  assertEquals(tenantData, null);
  assert(before?.pdu.includes('erase-secret'));
});

suite.test('erase defaults false and rejects non-boolean input without deactivating', async () => {
  const user = await suite.registerTestUser('erase-plain', 'pw');
  const reader = await suite.registerTestUser('erase-reader', 'pw');
  const token = user.access_token!, readToken = reader.access_token!;
  const made = await call('/createRoom', token, 'POST', {
    preset: 'public_chat',
  });
  const path = '/rooms/' + encodeURIComponent(String(made.body.room_id));
  const sent = await call(path + '/send/m.room.message/plain', token, 'PUT', {
    body: 'not-erased',
    msgtype: 'm.text',
  });
  const auth = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: user.user_id },
    password: 'pw',
  };
  assertEquals(
    (await call('/account/deactivate', token, 'POST', { erase: 'true', auth }))
      .status,
    400,
  );
  assertEquals((await call('/account/whoami', token)).status, 200);
  assertEquals(
    (await call('/account/deactivate', token, 'POST', { auth })).status,
    200,
  );
  await call(path + '/join', readToken, 'POST', {});
  assertEquals(
    (await call(
      path + '/event/' + encodeURIComponent(String(sent.body.event_id)),
      readToken,
    )).body.content,
    { body: 'not-erased', msgtype: 'm.text' },
  );
});
