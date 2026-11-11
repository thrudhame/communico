// Cross-endpoint and late-fork assertions from doltgres sync/pushrules tests.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP sync filters and streams');
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
const sync = async (token: string, query = '') => {
  const res = await call('/_matrix/client/v3/sync?timeout=0' + query, token);
  assertEquals(res.status, 200);
  return res.body;
};
const joined = (body: Json, roomId: string) =>
  ((body.rooms as Json).join as Json)[roomId] as Json;

suite.test('prev_batch reads the same historical membership via /members?at=', async () => {
  const alice = await suite.registerTestUser('sy-at-a', 'pw');
  const bob = await suite.registerTestUser('sy-at-b', 'pw');
  const created = await call(
    '/_matrix/client/v3/createRoom',
    alice.access_token!,
    'POST',
    { preset: 'public_chat' },
  );
  assertEquals(created.status, 200);
  const roomId = String(created.body.room_id);
  const base = '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId);
  assertEquals(
    (await call(base + '/send/m.room.message/at1', alice.access_token!, 'PUT', {
      msgtype: 'm.text',
      body: 'hello',
    })).status,
    200,
  );
  const before = await sync(
    alice.access_token!,
    '&filter=' +
      encodeURIComponent('{"room":{"timeline":{"types":["m.room.message"]}}}'),
  );
  const prev = (joined(before, roomId).timeline as Json).prev_batch;
  assertEquals(
    (await call(base + '/join', bob.access_token!, 'POST', {})).status,
    200,
  );
  const members = await call(base + '/members?at=' + prev, alice.access_token!);
  assertEquals(members.status, 200);
  assertEquals((members.body.chunk as Json[]).map((e) => e.state_key).sort(), [
    alice.user_id,
  ]);
  for (const at of ['unknown', 'c999999_0']) {
    assertEquals(
      (await call(base + '/members?at=' + at, alice.access_token!)).status,
      400,
    );
  }
});

suite.test('late S2 fork off E1 survives later E3/E4 and filtered E5 in start-state', async () => {
  const alice = await suite.registerTestUser('sy-late', 'pw');
  const created = await call(
    '/_matrix/client/v3/createRoom',
    alice.access_token!,
    'POST',
    { preset: 'public_chat' },
  );
  assertEquals(created.status, 200);
  const roomId = String(created.body.room_id);
  const app = theApp();
  const room = await openRoom(app.store, roomId);
  const signer = app.tenant.signer();
  const message = (body: string) =>
    sendLocal(room, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: { msgtype: 'm.text', body },
    }, signer);
  const e1 = await message('E1');
  await message('E3');
  const e4 = await message('E4');
  const s2 = await sendLocal(room, {
    type: 'm.room.name',
    state_key: '',
    sender: alice.user_id,
    content: { name: 'I am the room name, S2' },
    prev_events: [e1.eventId],
  }, signer);
  await sendLocal(room, {
    type: 'please_filter_me',
    sender: alice.user_id,
    content: { msgtype: 'm.text', body: 'E5' },
    prev_events: [e4.eventId, s2.eventId],
  }, signer);
  const result = await sync(
    alice.access_token!,
    '&filter=' +
      encodeURIComponent(
        '{"room":{"timeline":{"not_types":["please_filter_me"],"limit":1}}}',
      ),
  );
  const entry = joined(result, roomId);
  assertEquals(
    ((entry.timeline as Json).events as Json[]).map((e) => e.event_id),
    [s2.eventId],
  );
  assert(
    ((entry.state as Json).events as Json[]).some((e) =>
      e.event_id === s2.eventId
    ),
  );
});

suite.test('push rule changes and deletes synthesize account data and wake the owner', async () => {
  const alice = await suite.registerTestUser('sy-push', 'pw');
  const token = alice.access_token!;
  const rule = '/_matrix/client/v3/pushrules/global/room/' +
    encodeURIComponent('!push:localhost');
  assertEquals(
    (await call(rule, token, 'PUT', { actions: ['dont_notify'] })).status,
    200,
  );
  assertEquals(
    (await call(rule + '/enabled', token, 'PUT', { enabled: false })).status,
    200,
  );
  const initial = await sync(token);
  const rules = (body: Json) => {
    const event = ((body.account_data as Json).events as Json[]).find((e) =>
      e.type === 'm.push_rules'
    );
    assert(event !== undefined);
    return ((event.content as Json).global as Json).room as Json[];
  };
  assertEquals(rules(initial), [{
    rule_id: '!push:localhost',
    actions: ['dont_notify'],
    default: false,
    enabled: false,
  }]);
  const waiting = call(
    '/_matrix/client/v3/sync?timeout=5000&since=' + initial.next_batch,
    token,
  );
  await new Promise((r) => setTimeout(r, 100));
  const start = performance.now();
  assertEquals(
    (await call(rule + '/actions', token, 'PUT', { actions: ['notify'] }))
      .status,
    200,
  );
  const woken = await waiting;
  assertEquals(woken.status, 200);
  assert(
    performance.now() - start < 450,
    'push-rule notification beats polling',
  );
  assertEquals(rules(woken.body)[0].actions, ['notify']);
  assertEquals((await call(rule, token, 'DELETE')).status, 200);
  const deleted = await sync(token, '&since=' + woken.body.next_batch);
  assertEquals(rules(deleted), []);
  assert(deleted.next_batch !== woken.body.next_batch);
  const unchanged = await sync(token, '&since=' + deleted.next_batch);
  assertEquals((unchanged.account_data as Json).events, []);
});
