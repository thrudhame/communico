import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP push thread counts');
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
const count = (notification_count: number, highlight_count = 0) => ({
  notification_count,
  highlight_count,
});
const entry = (body: Json, room: string) =>
  ((body.rooms as Json).join as Json)[room] as Json;

suite.test('split counts, exact partial scopes, fully_read and own-send share one ledger', async () => {
  const a = await suite.registerTestUser('push-thread-a', 'pw');
  const b = await suite.registerTestUser('push-thread-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const filter = (split?: boolean) => ({
    room: {
      timeline: {
        limit: 0,
        ...(split === undefined ? {} : { unread_thread_notifications: split }),
      },
    },
  });
  const sync = (split?: boolean, since?: unknown) =>
    call(
      'sync?filter=' + encodeURIComponent(JSON.stringify(filter(split))) +
        (since ? '&since=' + since : ''),
      b.access_token!,
    );
  let txn = 0;
  const send = async (token: string, root?: string, highlight = false) =>
    String(
      (await call(base + '/send/m.room.message/' + (++txn), token, {
        msgtype: 'm.text',
        body: 'activity',
        'm.mentions': highlight ? { user_ids: [b.user_id] } : {},
        ...(root
          ? { 'm.relates_to': { rel_type: 'm.thread', event_id: root } }
          : {}),
      }, 'PUT')).event_id,
    );
  const rootA = await send(a.access_token!);
  const firstA = await send(a.access_token!, rootA);
  const rootB = await send(a.access_token!);
  await send(a.access_token!, rootB);
  const lastA = await send(a.access_token!, rootA, true);
  const main = await send(a.access_token!);
  for (const split of [undefined, false]) {
    const got = entry(await sync(split), room);
    assertEquals(got.unread_notifications, count(6, 1));
    assertEquals(got.unread_thread_notifications, undefined);
    assertEquals((got.timeline as Json).events, []);
  }
  const check = async (
    mainCount: number,
    aCount: number,
    bCount: number,
    highlights = 1,
  ) => {
    const result = await sync(true);
    const got = entry(result, room);
    assertEquals(got.unread_notifications, count(mainCount));
    assertEquals(got.unread_thread_notifications, {
      [rootA]: count(aCount, highlights),
      [rootB]: count(bCount),
    });
    return result;
  };
  await check(3, 2, 1);
  const stored = await call(
    'user/' + encodeURIComponent(b.user_id) + '/filter',
    b.access_token!,
    filter(true),
  );
  assertEquals(
    entry(await call('sync?filter=' + stored.filter_id, b.access_token!), room)
      .unread_notifications,
    count(3),
  );
  const read = (event: string, type: string, thread_id?: string) =>
    call(
      base + '/receipt/' + type + '/' + encodeURIComponent(event),
      b.access_token!,
      thread_id === undefined ? {} : { thread_id },
    );
  await read(firstA, 'm.read.private', rootA);
  await check(3, 1, 1);
  await read(main, 'm.read', 'main');
  const before = await check(0, 1, 1);
  await call(base + '/read_markers', b.access_token!, {
    'm.fully_read': lastA,
  });
  await call(
    'user/' + encodeURIComponent(b.user_id) + '/rooms/' +
      encodeURIComponent(room) + '/account_data/m.marked_unread',
    b.access_token!,
    { unread: false },
    'PUT',
  );
  await check(0, 1, 1);
  await send(b.access_token!, rootB);
  await check(0, 1, 0);
  await read(main, 'm.read.private');
  const zero = entry(await sync(true, before.next_batch), room);
  assertEquals(zero.unread_notifications, count(0));
  assertEquals(zero.unread_thread_notifications, {
    [rootA]: count(0),
    [rootB]: count(0),
  });
  await read(firstA, 'm.read', rootA);
  await check(0, 0, 0, 0);
});

suite.test('private count-only zero wakes owner with a filtered timeline', async () => {
  const a = await suite.registerTestUser('push-count-wake-a', 'pw');
  const b = await suite.registerTestUser('push-count-wake-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const sent = await call(base + '/send/m.room.message/wake', a.access_token!, {
    body: 'activity',
  }, 'PUT');
  const filter = encodeURIComponent(
    JSON.stringify({
      room: {
        timeline: { types: ['never'], unread_thread_notifications: true },
      },
    }),
  );
  const first = await call('sync?filter=' + filter, b.access_token!);
  assertEquals(entry(first, room).unread_notifications, count(1));
  const pending = call(
    'sync?timeout=3000&filter=' + filter + '&since=' + first.next_batch,
    b.access_token!,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  await call(
    base + '/receipt/m.read.private/' +
      encodeURIComponent(String(sent.event_id)),
    b.access_token!,
    {},
  );
  const result = await pending;
  assert(
    Number(String(result.next_batch).match(/_n(\d+)/)?.[1]) >
      Number(String(first.next_batch).match(/_n(\d+)/)?.[1]),
  );
  assertEquals(entry(result, room).unread_notifications, count(0));
  assertEquals((entry(result, room).timeline as Json).events, []);
});

suite.test('a related main event acknowledges only the requested thread horizon', async () => {
  const a = await suite.registerTestUser('push-related-a', 'pw');
  const b = await suite.registerTestUser('push-related-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  let txn = 0;
  const send = async (parent?: string, rel_type?: string) =>
    String(
      (await call(base + '/send/m.room.message/' + (++txn), a.access_token!, {
        body: 'activity',
        'm.mentions': {},
        ...(parent ? { 'm.relates_to': { event_id: parent, rel_type } } : {}),
      }, 'PUT')).event_id,
    );
  const root = await send();
  await send(root, 'm.thread');
  const f = await send(root, 'm.reference');
  const g = await send(f, 'm.annotation');
  const sync = async () =>
    entry(
      await call(
        'sync?filter=' +
          encodeURIComponent(
            JSON.stringify({
              room: { timeline: { unread_thread_notifications: true } },
            }),
          ),
        b.access_token!,
      ),
      room,
    );
  assertEquals((await sync()).unread_notifications, count(3));
  assertEquals((await sync()).unread_thread_notifications, {
    [root]: count(1),
  });
  await call(
    base + '/receipt/m.read.private/' + encodeURIComponent(g),
    b.access_token!,
    { thread_id: root },
  );
  assertEquals((await sync()).unread_notifications, count(3));
  assertEquals((await sync()).unread_thread_notifications, {
    [root]: count(0),
  });
  await call(
    base + '/receipt/m.read/' + encodeURIComponent(g),
    b.access_token!,
    { thread_id: 'main' },
  );
  assertEquals((await sync()).unread_notifications, count(0));
});

suite.test('redaction withdraws unread contributions and wakes a count-only zero', async () => {
  const a = await suite.registerTestUser('push-redact-a', 'pw');
  const b = await suite.registerTestUser('push-redact-b', 'pw');
  const room = String(
    (await call('createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  const event = String(
    (await call(base + '/send/m.room.message/redact', a.access_token!, {
      body: 'activity',
      'm.mentions': { user_ids: [b.user_id] },
    }, 'PUT')).event_id,
  );
  const filter = encodeURIComponent(
    JSON.stringify({ room: { timeline: { types: ['never'] } } }),
  );
  const first = await call('sync?filter=' + filter, b.access_token!);
  assertEquals(entry(first, room).unread_notifications, count(1, 1));
  const pending = call(
    'sync?timeout=3000&filter=' + filter + '&since=' + first.next_batch,
    b.access_token!,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  await call(
    base + '/redact/' + encodeURIComponent(event) + '/withdraw',
    a.access_token!,
    {},
    'PUT',
  );
  const result = await pending;
  assertEquals(entry(result, room).unread_notifications, count(0));
  assertEquals((entry(result, room).timeline as Json).events, []);
  assert(
    Number(String(result.next_batch).match(/_n(\d+)/)?.[1]) >
      Number(String(first.next_batch).match(/_n(\d+)/)?.[1]),
  );
});
