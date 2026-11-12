// Room, thread, public and private receipts have independent durable identities.
import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { eduQueues } from '#engine/federation/edus.ts';
import { theApp } from '#engine/app.ts';
import { threadOfEvent } from '#engine/server/read.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP threaded receipts');
async function call(
  path: string,
  token: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function ok(
  path: string,
  token: string,
  body?: unknown,
  method?: string,
) {
  const result = await call(path, token, body, method);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function setup(prefix: string) {
  const a = await suite.registerTestUser(prefix + '-a', 'pw');
  const b = await suite.registerTestUser(prefix + '-b', 'pw');
  const room = String(
    (await ok('createRoom', a.access_token!, { invite: [b.user_id] })).room_id,
  );
  const base = 'rooms/' + encodeURIComponent(room);
  await ok(base + '/join', b.access_token!, {});
  const send = async (name: string, parent?: string, relation = 'm.thread') =>
    String(
      (await ok(
        base + '/send/m.room.message/' + name,
        a.access_token!,
        {
          msgtype: 'm.text',
          body: name,
          ...(parent === undefined
            ? {}
            : { 'm.relates_to': { rel_type: relation, event_id: parent } }),
        },
        'PUT',
      )).event_id,
    );
  const root = await send('root'), otherRoot = await send('other-root');
  const reply = await send('reply', root),
    otherReply = await send('other-reply', otherRoot);
  const receipt = (event: string, type = 'm.read') =>
    base + '/receipt/' + type + '/' + encodeURIComponent(event);
  const sync = (token: string, since?: unknown) =>
    ok(
      'sync?timeout=0' + (since === undefined ? '' : '&since=' + since),
      token,
    );
  return {
    a,
    b,
    room,
    base,
    send,
    root,
    otherRoot,
    reply,
    otherReply,
    receipt,
    sync,
  };
}
function marks(body: Json, room: string, user: string) {
  const joined = ((body.rooms as Json).join as Json)[room] as Json | undefined;
  const result: { event: string; type: string; thread: string | null }[] = [];
  for (const event of ((joined?.ephemeral as Json)?.events ?? []) as Json[]) {
    if (event.type !== 'm.receipt') continue;
    for (const [id, types] of Object.entries(event.content as Json)) {
      for (const [type, users] of Object.entries(types as Json)) {
        const mark = (users as Json)[user] as Json | undefined;
        if (mark !== undefined) {
          result.push({
            event: id,
            type,
            thread: typeof mark.thread_id === 'string' ? mark.thread_id : null,
          });
        }
      }
    }
  }
  return result;
}

suite.test('unthreaded/main/two threads and both receipt types survive sync without overwriting', async () => {
  const f = await setup('thread-slots');
  const expected = [
    { event: f.root, type: 'm.read', thread: null },
    { event: f.root, type: 'm.read', thread: 'main' },
    { event: f.reply, type: 'm.read', thread: f.root },
    { event: f.otherReply, type: 'm.read', thread: f.otherRoot },
    { event: f.root, type: 'm.read.private', thread: 'main' },
    { event: f.reply, type: 'm.read.private', thread: f.root },
    { event: f.otherReply, type: 'm.read.private', thread: f.otherRoot },
  ];
  for (const mark of expected) {
    await ok(
      f.receipt(mark.event, mark.type),
      f.a.access_token!,
      mark.thread === null ? {} : { thread_id: mark.thread },
    );
  }
  const sort = (values: typeof expected) =>
    values.map((v) => JSON.stringify(v)).sort();
  const initial = await f.sync(f.a.access_token!);
  assertEquals(sort(marks(initial, f.room, f.a.user_id)), sort(expected));
  assertEquals(
    sort(marks(await f.sync(f.b.access_token!), f.room, f.a.user_id)),
    sort(expected.filter((m) => m.type === 'm.read')),
  );
  const later = await f.send('later', f.root);
  await ok(f.receipt(later), f.a.access_token!, { thread_id: f.root });
  const delta = marks(
    await f.sync(f.a.access_token!, initial.next_batch),
    f.room,
    f.a.user_id,
  );
  assertEquals(delta, [{ event: later, type: 'm.read', thread: f.root }]);
  expected[2].event = later;
  assertEquals(
    sort(marks(await f.sync(f.a.access_token!), f.room, f.a.user_id)),
    sort(expected),
  );
});

suite.test('unknown-thread capacity is a 429 rather than a not-joined error, with no partial receipt', async () => {
  const f = await setup('thread-capacity');
  await theApp().server.execute(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
    INSERT INTO receipts(room_id,user_id,receipt_type,thread_id,event_id,ts_ms,seq)
    SELECT ?,?,'m.read','$unknown-' || i,?,0,0 FROM n`,
    [f.room, f.a.user_id, f.root],
  );
  const result = await call(f.receipt(f.root), f.a.access_token!, {
    thread_id: '$overflow',
  });
  assertEquals([result.status, result.body.errcode], [429, 'M_LIMIT_EXCEEDED']);
  assertEquals(
    await theApp().server.query(
      'SELECT 1 FROM receipts WHERE room_id=? AND thread_id=?',
      [f.room, '$overflow'],
    ),
    [],
  );
  await ok(f.receipt(f.reply), f.a.access_token!, { thread_id: f.root });
});

suite.test('thread roots and their non-thread relations stay on main; reply relations stay in their thread', async () => {
  const f = await setup('thread-membership');
  const noBody = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/' + f.receipt(f.root),
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + f.a.access_token! },
      },
    ),
  );
  assertEquals(noBody.status, 200);
  await noBody.arrayBuffer();
  const onReply = await f.send('reaction-to-reply', f.reply, 'm.annotation');
  const onRoot = await f.send('reaction-to-root', f.root, 'm.annotation');
  const indirectRoot = await f.send(
    'reaction-to-root-relation',
    onRoot,
    'm.annotation',
  );
  for (
    const [event, thread] of [[f.root, 'main'], [onRoot, 'main'], [
      f.reply,
      f.root,
    ], [onReply, f.root]]
  ) {
    await ok(f.receipt(event), f.a.access_token!, { thread_id: thread });
    assertEquals(await threadOfEvent(theApp().server, f.room, event), thread);
  }
  for (const event of [f.root, onRoot, indirectRoot]) {
    assertEquals(await threadOfEvent(theApp().server, f.room, event), 'main');
    for (const type of ['m.read', 'm.read.private']) {
      await ok(f.receipt(event, type), f.a.access_token!, {
        thread_id: f.root,
      });
    }
  }
  for (
    const [event, thread] of [[f.reply, 'main'], [f.otherRoot, f.root], [
      f.reply,
      f.otherRoot,
    ]]
  ) {
    const result = await call(f.receipt(event), f.a.access_token!, {
      thread_id: thread,
    });
    assertEquals([result.status, result.body.errcode], [
      400,
      'M_INVALID_PARAM',
    ]);
  }
  for (const thread of ['', null, 1, {}, [], 'not-an-event']) {
    const result = await call(f.receipt(f.reply), f.a.access_token!, {
      thread_id: thread,
    });
    assertEquals([result.status, result.body.errcode], [
      400,
      'M_INVALID_PARAM',
    ]);
  }
  const rootEvent = await ok(
    f.base + '/event/' + encodeURIComponent(f.root),
    f.a.access_token!,
  );
  const bundle =
    ((rootEvent.unsigned as Json)['m.relations'] as Json)['m.thread'] as Json;
  assertEquals(bundle.count, 1);
  // Participation explicitly includes the root author; event membership does not.
  assertEquals(bundle.current_user_participated, true);
});

Deno.test('receipt EDU coalescing and bounded drain preserve each thread for one user', () => {
  const queues = eduQueues((user) => user === '@local:test');
  for (
    const [index, threadId] of [null, 'main', '$root1', '$root2'].entries()
  ) {
    queues.queueReceipt('remote', {
      roomId: '!r:test',
      userId: '@local:test',
      eventId: '$event' + index,
      ts: index,
      threadId,
    }, index + 1);
  }
  queues.queueReceipt('remote', {
    roomId: '!r:test',
    userId: '@local:test',
    eventId: '$stale',
    ts: 0,
    threadId: '$root1',
  }, 0);
  const received: Json[] = [];
  for (let i = 0; i < 4; i++) {
    const drained = queues.drain('remote', 1);
    assertEquals(drained.length, 1);
    assertEquals(drained[0].edu_type, 'm.receipt');
    received.push(
      (((drained[0].content['!r:test'] as Json)['m.read'] as Json)[
        '@local:test'
      ]) as Json,
    );
  }
  assertEquals(
    received.map((r) => ({ event_ids: r.event_ids, data: r.data })),
    [
      { event_ids: ['$event0'], data: { ts: 0 } },
      { event_ids: ['$event1'], data: { ts: 1, thread_id: 'main' } },
      { event_ids: ['$event2'], data: { ts: 2, thread_id: '$root1' } },
      { event_ids: ['$event3'], data: { ts: 3, thread_id: '$root2' } },
    ],
  );
  assertEquals(queues.drain('remote', 100), []);
});
