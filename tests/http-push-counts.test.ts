import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP push publication counts');
async function call(
  path: string,
  token: string,
  body?: unknown,
  method?: string,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as Json;
}
const sync = (token: string, since?: unknown) =>
  call('sync' + (since ? '?since=' + since : ''), token);
function joined(body: Json, room: string): Json {
  return ((body.rooms as Json).join as Json)[room] as Json;
}
const counts = (body: Json, room: string) =>
  joined(body, room).unread_notifications;

suite.test('encrypted envelopes notify without inventing decrypted highlights', async () => {
  const a = await suite.registerTestUser('push-cipher-a', 'pw');
  const b = await suite.registerTestUser('push-cipher-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, {
      invite: [b.user_id],
      initial_state: [{
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
    })).room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const before = await sync(b.access_token!);
  const content = {
    algorithm: 'm.megolm.v1.aes-sha2',
    ciphertext: 'opaque-ciphertext',
    session_id: 'session',
    sender_key: 'sender-key',
    device_id: 'device',
  };
  const sent = await call(
    base + '/send/m.room.encrypted/cipher',
    a.access_token!,
    content,
    'PUT',
  );
  const body = await sync(b.access_token!, before.next_batch);
  assertEquals(counts(body, room), {
    notification_count: 1,
    highlight_count: 0,
  });
  const event = ((joined(body, room).timeline as Json).events as Json[]).find((
    e,
  ) => e.event_id === sent.event_id)!;
  assertEquals(event.content, content);
});

suite.test('event and exact counts publish together, without pushers; private partial reads are monotone', async () => {
  const a = await suite.registerTestUser('push-count-a', 'pw');
  const b = await suite.registerTestUser('push-count-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const before = await sync(b.access_token!);
  const send = async (txn: string, body: string) =>
    String(
      (await call(base + '/send/m.room.message/' + txn, a.access_token!, {
        msgtype: 'm.text',
        body,
      }, 'PUT')).event_id,
    );
  const first = await send('one', 'one');
  const second = await send('two', b.user_id);
  const delta = await sync(b.access_token!, before.next_batch);
  const timeline = (joined(delta, room).timeline as Json).events as Json[];
  assert(timeline.some((e) => e.event_id === first));
  assert(timeline.some((e) => e.event_id === second));
  assertEquals(counts(delta, room), {
    notification_count: 2,
    highlight_count: 1,
  });
  assertEquals(counts(await sync(a.access_token!), room), {
    notification_count: 0,
    highlight_count: 0,
  });
  await call(
    base + '/receipt/m.read.private/' + encodeURIComponent(first),
    b.access_token!,
    {},
  );
  assertEquals(counts(await sync(b.access_token!, delta.next_batch), room), {
    notification_count: 1,
    highlight_count: 1,
  });
  await call(
    base + '/receipt/m.read/' + encodeURIComponent(second),
    b.access_token!,
    {},
  );
  await call(
    base + '/receipt/m.read.private/' + encodeURIComponent(first),
    b.access_token!,
    {},
  );
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 0,
    highlight_count: 0,
  });
  await send('three', 'three');
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 1,
    highlight_count: 0,
  });
});

suite.test('rules and ignored users affect future publication, not saved decisions', async () => {
  const a = await suite.registerTestUser('push-rule-a', 'pw');
  const b = await suite.registerTestUser('push-rule-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const send = (txn: string) =>
    call(base + '/send/m.room.message/' + txn, a.access_token!, {
      msgtype: 'm.text',
      body: 'hello',
    }, 'PUT');
  await send('one');
  await call(
    'pushrules/global/override/.m.rule.master/enabled',
    b.access_token!,
    { enabled: true },
    'PUT',
  );
  await send('two');
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 1,
    highlight_count: 0,
  });
  await call(
    'pushrules/global/override/.m.rule.master/enabled',
    b.access_token!,
    { enabled: false },
    'PUT',
  );
  await call(
    'user/' + encodeURIComponent(b.user_id) +
      '/account_data/m.ignored_user_list',
    b.access_token!,
    { ignored_users: { [a.user_id]: {} } },
    'PUT',
  );
  await send('three');
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 1,
    highlight_count: 0,
  });
});

suite.test('room profiles, live joined count and event-context notification power drive decisions', async () => {
  const a = await suite.registerTestUser('push-context-a', 'pw');
  const b = await suite.registerTestUser('push-context-b', 'pw');
  const c = await suite.registerTestUser('push-context-c', 'pw');
  await call(
    'profile/' + encodeURIComponent(b.user_id) + '/displayname',
    b.access_token!,
    { displayname: 'GlobalOnly' },
    'PUT',
  );
  const room = String(
    (await call('createRoom', a.access_token!, {
      invite: [b.user_id, c.user_id],
    })).room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  await call(
    base + '/state/m.room.member/' + encodeURIComponent(b.user_id),
    b.access_token!,
    { membership: 'join', displayname: 'RoomOnly' },
    'PUT',
  );
  const send = (token: string, txn: string, body: string) =>
    call(base + '/send/m.room.message/' + txn, token, {
      msgtype: 'm.text',
      body,
    }, 'PUT');
  await send(a.access_token!, 'room-profile', 'hello RoomOnly');
  await send(a.access_token!, 'global-profile', 'hello GlobalOnly');
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 2,
    highlight_count: 1,
  });
  await send(a.access_token!, 'owner-power', '@room');
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 3,
    highlight_count: 2,
  });
  await call(base + '/join', c.access_token!, {});
  await send(c.access_token!, 'ordinary-power', '@room');
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 4,
    highlight_count: 2,
  });
  await call('pushrules/global/override/three-members', b.access_token!, {
    conditions: [{ kind: 'room_member_count', is: '3' }],
    actions: [],
  }, 'PUT');
  await send(
    a.access_token!,
    'three-members',
    'silent at the actual live joined count',
  );
  assertEquals(counts(await sync(b.access_token!), room), {
    notification_count: 4,
    highlight_count: 2,
  });
});
