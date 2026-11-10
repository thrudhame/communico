import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP complete sync filters');
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
const events = (section: unknown) => (section as Json).events as Json[];
suite.test('inline and stored streams filter before limits and retain independent cuts', async () => {
  const alice = await suite.registerTestUser('fc-a', 'pw');
  const bob = await suite.registerTestUser('fc-b', 'pw');
  const token = alice.access_token!;
  const create = await call('/_matrix/client/v3/createRoom', token, 'POST', {
    preset: 'public_chat',
  });
  const room = String(create.body.room_id), encoded = encodeURIComponent(room);
  const base = '/_matrix/client/v3/rooms/' + encoded;
  assertEquals(
    (await call(base + '/join', bob.access_token!, 'POST', {})).status,
    200,
  );
  const user = '/_matrix/client/v3/user/' + encodeURIComponent(alice.user_id);
  await call(user + '/account_data/u.keep', token, 'PUT', { kept: true });
  await call(user + '/account_data/u.drop', token, 'PUT', { dropped: true });
  await call(
    user + '/rooms/' + encoded + '/account_data/u.keep',
    token,
    'PUT',
    { kept: true },
  );
  await call(
    user + '/rooms/' + encoded + '/account_data/u.drop',
    token,
    'PUT',
    { dropped: true },
  );
  await call(
    base + '/typing/' + encodeURIComponent(bob.user_id),
    bob.access_token!,
    'PUT',
    { typing: true, timeout: 30000 },
  );
  const send = async (id: string, who: string, content: Json) => {
    const response = await call(
      base + '/send/u.message/' + id,
      who,
      'PUT',
      content,
    );
    assertEquals(response.status, 200);
    return response.body.event_id;
  };
  const kept = await send('kept', token, { body: 'kept', url: 'mxc://test/a' });
  await send('wrong-sender', bob.access_token!, {
    body: 'wrong sender',
    url: 'mxc://test/b',
  });
  await send('wrong-url', token, { body: 'wrong url' });
  const filter = {
    presence: { senders: [bob.user_id], types: ['m.*'] },
    account_data: { types: ['u.*'], not_types: ['*.drop'] },
    room: {
      rooms: [room],
      timeline: {
        types: ['u.*'],
        senders: [alice.user_id],
        contains_url: true,
        limit: 1,
      },
      state: { types: ['m.room.*'], not_types: ['*.member'] },
      ephemeral: { not_types: ['m.*'] },
      account_data: { types: ['u.keep'] },
    },
  };
  const stored = await call(user + '/filter', token, 'POST', filter);
  assertEquals(stored.status, 200);
  for (const value of [JSON.stringify(filter), String(stored.body.filter_id)]) {
    const result = await call(
      '/_matrix/client/v3/sync?timeout=0&filter=' + encodeURIComponent(value),
      token,
    );
    assertEquals(result.status, 200);
    const joined = ((result.body.rooms as Json).join as Json)[room] as Json;
    assertEquals(events(joined.timeline).map((e) => e.event_id), [kept]);
    assert(events(joined.state).length > 0);
    assert(events(joined.state).every((e) => e.type !== 'm.room.member'));
    assertEquals(events(joined.ephemeral), []);
    assertEquals(events(joined.account_data).map((e) => e.type), ['u.keep']);
    assertEquals(events(result.body.account_data).map((e) => e.type), [
      'u.keep',
    ]);
    assertEquals(events(result.body.presence).map((e) => e.sender), [
      bob.user_id,
    ]);
  }
  const excluded = {
    presence: { types: [] },
    account_data: { types: [] },
    room: { rooms: [] },
  };
  const empty = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' +
      encodeURIComponent(JSON.stringify(excluded)),
    token,
  );
  assertEquals(empty.body.rooms, {
    join: {},
    invite: {},
    knock: {},
    leave: {},
  });
  assertEquals(events(empty.body.presence), []);
  assertEquals(events(empty.body.account_data), []);
  assertEquals(
    (await call(
      '/_matrix/client/v3/sync?timeout=0&filter=' +
        encodeURIComponent('{"presence":{"senders":[1]}}'),
      token,
    )).status,
    400,
  );
  const secondary = {
    room: {
      timeline: { rooms: [] },
      state: { not_rooms: [room] },
      ephemeral: { senders: [bob.user_id] },
      account_data: { senders: [alice.user_id] },
    },
  };
  const limited = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' +
      encodeURIComponent(JSON.stringify(secondary)),
    token,
  );
  const joined = ((limited.body.rooms as Json).join as Json)[room] as Json;
  assertEquals(events(joined.timeline), []);
  assertEquals(events(joined.state), []);
  assertEquals(events(joined.ephemeral), []); // No synthetic sender on m.typing.
  assertEquals(events(joined.account_data), []); // No synthetic sender on account data.
  const advanced = await call(
    '/_matrix/client/v3/sync?timeout=0&since=' + empty.body.next_batch,
    token,
  );
  assertEquals(((advanced.body.rooms as Json).join as Json)[room], undefined);
  assertEquals(events(advanced.body.account_data), []);
  const format = {
    event_format: 'federation',
    room: { timeline: { types: ['u.message'], limit: 1 } },
  };
  const federation = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' +
      encodeURIComponent(JSON.stringify(format)),
    token,
  );
  const wireRoom = ((federation.body.rooms as Json).join as Json)[room] as Json;
  const wire = events(wireRoom.timeline)[0];
  assert(Array.isArray(wire.auth_events));
  assert(Array.isArray(wire.prev_events));
  assert(wire.signatures !== undefined);
  assertEquals(wire.room_id, room);
  assert(
    events(wireRoom.state).every((event) => event.signatures !== undefined),
  );
  const streamLimits = {
    presence: { not_senders: [bob.user_id], limit: 1 },
    account_data: { types: ['u.*'], limit: 1 },
    room: {
      state: { types: ['m.room.member'], senders: [bob.user_id], limit: 1 },
      timeline: { limit: 0 },
      ephemeral: { types: ['m.typ*'], limit: 1 },
      account_data: { limit: 1 },
    },
  };
  const capped = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' +
      encodeURIComponent(JSON.stringify(streamLimits)),
    token,
  );
  const cappedRoom = ((capped.body.rooms as Json).join as Json)[room] as Json;
  assertEquals(events(cappedRoom.timeline), []);
  assertEquals(events(cappedRoom.state).map((event) => event.sender), [
    bob.user_id,
  ]);
  assertEquals(events(cappedRoom.ephemeral).map((event) => event.type), [
    'm.typing',
  ]);
  assertEquals(events(cappedRoom.account_data).length, 1);
  assertEquals(events(capped.body.account_data).length, 1);
  assertEquals(events(capped.body.presence).map((event) => event.sender), [
    alice.user_id,
  ]);

  // Ignore/visibility admission must not let a hidden newer event consume the
  // only timeline slot. Filtering is separate from the global stream cut.
  await call(user + '/account_data/m.ignored_user_list', token, 'PUT', {
    ignored_users: { [bob.user_id]: {} },
  });
  const visible = await send('visible-before-hidden', token, {
    body: 'visible',
  });
  await send('hidden-newer', bob.access_token!, { body: 'hidden' });
  const visibleResult = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' +
      encodeURIComponent(
        JSON.stringify({ room: { timeline: { types: ['u.*'], limit: 1 } } }),
      ),
    token,
  );
  const visibleRoom =
    ((visibleResult.body.rooms as Json).join as Json)[room] as Json;
  assertEquals(events(visibleRoom.timeline).map((event) => event.event_id), [
    visible,
  ]);
});
