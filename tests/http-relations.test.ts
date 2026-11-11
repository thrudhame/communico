import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP relation views');
async function call(
  path: string,
  token: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
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
    (await ok('v3/createRoom', a.access_token!, { invite: [b.user_id] }))
      .room_id,
  );
  const base = 'v3/rooms/' + encodeURIComponent(room);
  const v1 = 'v1/rooms/' + encodeURIComponent(room);
  await ok(base + '/join', b.access_token!, {});
  const send = async (
    name: string,
    relation?: unknown,
    token = a.access_token!,
  ) =>
    String(
      (await ok(
        base + '/send/m.room.message/' + name,
        token,
        {
          msgtype: 'm.text',
          body: name,
          ...(relation === undefined ? {} : { 'm.relates_to': relation }),
        },
        'PUT',
      )).event_id,
    );
  const root = await send('root');
  const relation = (id: string, rel_type = 'm.thread') => ({
    event_id: id,
    rel_type,
  });
  const page = (id = root, query = '', suffix = '') =>
    ok(
      v1 + '/relations/' + encodeURIComponent(id) + suffix + query,
      b.access_token!,
    );
  const event = (id = root) =>
    ok(base + '/event/' + encodeURIComponent(id), b.access_token!);
  const ignore = () =>
    ok(
      'v3/user/' + encodeURIComponent(b.user_id) +
        '/account_data/m.ignored_user_list',
      b.access_token!,
      { ignored_users: { [a.user_id]: {} } },
      'PUT',
    );
  return { a, b, room, base, v1, send, root, relation, page, event, ignore };
}
const ids = (body: Json) => (body.chunk as Json[]).map((e) => e.event_id);
const bundle = (event: Json) =>
  ((event.unsigned as Json)?.['m.relations'] as Json)?.['m.thread'] as
    | Json
    | undefined;

suite.test('empty relation and thread cursors mean omitted; nonempty malformed cursors still fail', async () => {
  const f = await setup('relation-empty');
  await f.send('reply', f.relation(f.root));
  for (
    const route of [
      f.v1 + '/relations/' + encodeURIComponent(f.root),
      f.v1 + '/threads',
    ]
  ) {
    const ordinary = await ok(route, f.b.access_token!);
    assertEquals(
      ids(await ok(route + '?from=&to=', f.b.access_token!)),
      ids(ordinary),
    );
    assertEquals(
      (await call(route + '?from=not-a-token', f.b.access_token!)).status,
      400,
    );
  }
});

suite.test('malformed, redacted and ignored relations share eligibility with thread bundles and list', async () => {
  const f = await setup('relation-view');
  await f.send('missing-type', { event_id: f.root });
  await f.send('bad-type', { event_id: f.root, rel_type: 3 });
  const first = await f.send('first', f.relation(f.root));
  const last = await f.send('last', f.relation(f.root));
  assertEquals(ids(await f.page()), [last, first]);
  assertEquals(bundle(await f.event())?.count, 2);
  await ok(
    f.base + '/redact/' + encodeURIComponent(last) + '/r',
    f.a.access_token!,
    {},
    'PUT',
  );
  assertEquals(ids(await f.page()), [first]);
  assertEquals(
    bundle(await f.event())?.latest_event &&
      (bundle(await f.event())!.latest_event as Json).event_id,
    first,
  );
  await f.ignore();
  assertEquals(ids(await f.page()), []);
  assertEquals(ids(await ok(f.v1 + '/threads', f.b.access_token!)), []);
  const own = await f.send('own', f.relation(f.root), f.b.access_token!);
  // The ignored root is not delivered, but the viewer's own relationship remains valid.
  assertEquals(ids(await f.page()), [own]);
});

suite.test('recursive traversal filters results, not intermediates, and reports requested recursion depth', async () => {
  const f = await setup('relation-recursion');
  const one = await f.send('one', f.relation(f.root, 'm.reference'));
  const two = await f.send(
    'two',
    f.relation(one, 'm.annotation'),
    f.b.access_token!,
  );
  const three = await f.send(
    'three',
    f.relation(two, 'm.reference'),
    f.b.access_token!,
  );
  assertEquals(ids(await f.page()), [one]);
  assertEquals('recursion_depth' in await f.page(), false);
  assertEquals((await f.page(f.root, '?recurse=false')).recursion_depth, 0);
  const recursive = await f.page(f.root, '?recurse=true');
  assertEquals(ids(recursive), [three, two, one]);
  assert(Number(recursive.recursion_depth) >= 3);
  await f.ignore();
  assertEquals(
    ids(await f.page(f.root, '?recurse=true', '/m.reference/m.room.message')),
    [three],
  );
  for (
    const query of [
      '?from=garbage',
      '?to=garbage',
      '?recurse=yes',
      '?limit=-1',
      '?dir=x',
    ]
  ) {
    assertEquals(
      (await call(
        f.v1 + '/relations/' + encodeURIComponent(f.root) + query,
        f.b.access_token!,
      )).status,
      400,
    );
  }
});

suite.test('relations round-trip opaque pages and accept sync/messages from/to bounds on every route', async () => {
  const f = await setup('relation-pages');
  const one = await f.send('one', f.relation(f.root));
  const cut1 = (await ok('v3/sync?timeout=0', f.b.access_token!)).next_batch;
  const two = await f.send('two', f.relation(f.root));
  const three = await f.send('three', f.relation(f.root));
  const cut2 = (await ok('v3/sync?timeout=0', f.b.access_token!)).next_batch;
  const four = await f.send('four', f.relation(f.root));
  for (const suffix of ['', '/m.thread', '/m.thread/m.room.message']) {
    assertEquals(
      ids(await f.page(f.root, '?dir=f&from=' + cut1 + '&to=' + cut2, suffix)),
      [two, three],
    );
    assertEquals(
      ids(await f.page(f.root, '?dir=b&from=' + cut2 + '&to=' + cut1, suffix)),
      [three, two],
    );
    assertEquals(ids(await f.page(f.root, '?dir=f&from=s0', suffix)), [
      one,
      two,
      three,
      four,
    ]);
    assertEquals(ids(await f.page(f.root, '?dir=f&to=s0', suffix)), []);
    assertEquals(ids(await f.page(f.root, '?dir=b&from=s0', suffix)), []);
    assertEquals(ids(await f.page(f.root, '?dir=b&to=s0', suffix)), [
      four,
      three,
      two,
      one,
    ]);
    const page = await f.page(f.root, '?limit=1', suffix);
    const next = await f.page(
      f.root,
      '?limit=1&from=' + page.next_batch,
      suffix,
    );
    assertEquals(ids(next), [three]);
    const last = await f.page(f.root, '?from=' + next.next_batch, suffix);
    assertEquals(ids(last), [two, one]);
  }
  const messages = await ok(
    f.base + '/messages?dir=b&limit=1',
    f.b.access_token!,
  );
  assertEquals(ids(await f.page(f.root, '?from=' + messages.end)), [
    three,
    two,
    one,
  ]);
});

suite.test('ignored ordinary messages disappear from sync/messages/search while state survives; nested latest_event matches sync shape', async () => {
  const f = await setup('relation-ignore');
  const reply = await f.send('reply', f.relation(f.root));
  const initial = await ok('v3/sync?timeout=0', f.b.access_token!);
  const joined = ((initial.rooms as Json).join as Json)[f.room] as Json;
  const timeline = (joined.timeline as Json).events as Json[];
  const root = timeline.find((e) => e.event_id === f.root)!;
  assertEquals((bundle(root)!.latest_event as Json).event_id, reply);
  assertEquals('room_id' in (bundle(root)!.latest_event as Json), false);
  await f.ignore();
  await ok(f.base + '/state/m.room.topic', f.a.access_token!, {
    topic: 'state survives',
  }, 'PUT');
  await f.send('ignored-new-message');
  const sync = await ok('v3/sync?timeout=0', f.b.access_token!);
  const room = ((sync.rooms as Json).join as Json)[f.room] as Json;
  const events = (room.timeline as Json).events as Json[];
  assertEquals(
    events.some((e) => e.type === 'm.room.message' && e.sender === f.a.user_id),
    false,
  );
  assert(events.some((e) => e.type === 'm.room.topic'));
  const messages = await ok(
    f.base + '/messages?dir=b&limit=100',
    f.b.access_token!,
  );
  assertEquals(
    (messages.chunk as Json[]).some((e) =>
      e.type === 'm.room.message' && e.sender === f.a.user_id
    ),
    false,
  );
  const search = await ok('v3/search', f.b.access_token!, {
    search_categories: { room_events: { search_term: 'ignored-new-message' } },
  });
  assertEquals(
    (((search.search_categories as Json).room_events as Json).results as Json[])
      .length,
    0,
  );
});

suite.test('fully_read receipt uses account data only, rejects threads, and does not clear notification counts', async () => {
  const f = await setup('relation-marker');
  const id = await f.send('unread');
  const before = await ok('v3/sync?timeout=0', f.b.access_token!);
  const roomEntry = (sync: Json) =>
    ((sync.rooms as Json).join as Json)[f.room] as Json;
  const counts = roomEntry(before).unread_notifications;
  const receipt = f.base + '/receipt/m.fully_read/' + encodeURIComponent(id);
  await ok(receipt, f.b.access_token!, {});
  const after = await ok('v3/sync?timeout=0', f.b.access_token!);
  assertEquals(roomEntry(after).unread_notifications, counts);
  const data = (roomEntry(after).account_data as Json).events as Json[];
  assertEquals(
    (data.find((e) => e.type === 'm.fully_read')!.content as Json).event_id,
    id,
  );
  assertEquals(
    (await call(receipt, f.b.access_token!, { thread_id: 'main' })).status,
    400,
  );
  await ok(f.base + '/read_markers', f.b.access_token!, {
    'm.fully_read': f.root,
  });
  const value = await ok(
    'v3/user/' + encodeURIComponent(f.b.user_id) + '/rooms/' +
      encodeURIComponent(f.room) + '/account_data/m.fully_read',
    f.b.access_token!,
  );
  assertEquals(value.event_id, f.root);
});

suite.test('thread lists order by eligible latest reply, paginate and derive participation before counting', async () => {
  const f = await setup('relation-thread-list');
  const one = await f.send('reply-1', f.relation(f.root));
  const other = await f.send('other-root');
  await f.send('reply-2', f.relation(other), f.b.access_token!);
  const list = (query = '') => ok(f.v1 + '/threads' + query, f.b.access_token!);
  assertEquals(ids(await list()), [other, f.root]);
  assertEquals(ids(await list('?include=participated')), [other]);
  const newest = await f.send('reply-3', f.relation(f.root), f.b.access_token!);
  assertEquals(ids(await list()), [f.root, other]);
  assertEquals(ids(await list('?include=participated')), [f.root, other]);
  const first = await list('?limit=1');
  assertEquals(ids(first), [f.root]);
  assertEquals(ids(await list('?from=' + first.next_batch)), [other]);
  await ok(
    f.base + '/redact/' + encodeURIComponent(newest) + '/newest',
    f.a.access_token!,
    {},
    'PUT',
  );
  assertEquals(ids(await list()), [other, f.root]);
  assertEquals(ids(await list('?include=participated')), [other]);
  // A parent redaction does not erase valid children or the thread bundle.
  await ok(
    f.base + '/redact/' + encodeURIComponent(f.root) + '/root',
    f.a.access_token!,
    {},
    'PUT',
  );
  assertEquals(ids(await f.page()), [one]);
  assertEquals(bundle(await f.event())?.count, 1);
  assertEquals(ids(await list()), [other, f.root]);
});

suite.test('thread bundle reads only the requested relation type despite a large unrelated index', async () => {
  const f = await setup('relation-bounded-types');
  const reply = await f.send('reply', f.relation(f.root));
  const server = theApp().server;
  // Seed the projection directly: rendering a thread must not hydrate unrelated
  // reaction PDUs, regardless of how many the shared relation index contains.
  await server.tx(async (tx) => {
    await tx.execute(
      `WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000
    ) INSERT INTO event_index(event,room,pos,standing,grounding)
      SELECT '$unrelated-' || i,?,-i,'accepted','grounded' FROM n`,
      [f.room],
    );
    await tx.execute(
      `INSERT INTO relations(event,relates_to,rel_type,room,seq)
      SELECT event,?,'m.annotation',room,pos FROM event_index
      WHERE room=? AND pos<0`,
      [f.root, f.room],
    );
  });
  const thread = bundle(await f.event())!;
  assertEquals(thread.count, 1);
  assertEquals((thread.latest_event as Json).event_id, reply);
  assertEquals(ids(await f.page(f.root, '', '/m.thread')), [reply]);
});

suite.test('both fully-read routes reject cross-room and unknown events without replacing the marker', async () => {
  const f = await setup('marker-room-owner');
  const other = await setup('marker-other-room');
  await ok(f.base + '/read_markers', f.b.access_token!, {
    'm.fully_read': f.root,
  });
  for (const event of [other.root, '$unknown:localhost']) {
    for (const receipt of [true, false]) {
      const result = await call(
        f.base +
          (receipt
            ? '/receipt/m.fully_read/' + encodeURIComponent(event)
            : '/read_markers'),
        f.b.access_token!,
        receipt ? {} : { 'm.fully_read': event },
      );
      assertEquals(result.status, 404);
      assertEquals(result.body.errcode, 'M_NOT_FOUND');
      const marker = await ok(
        'v3/user/' + encodeURIComponent(f.b.user_id) + '/rooms/' +
          encodeURIComponent(f.room) + '/account_data/m.fully_read',
        f.b.access_token!,
      );
      assertEquals(marker.event_id, f.root);
    }
  }
});

suite.test('both fully-read routes hide events before a joined-history reader arrived', async () => {
  const a = await suite.registerTestUser('marker-hidden-a', 'pw');
  const b = await suite.registerTestUser('marker-hidden-b', 'pw');
  const room = String(
    (await ok('v3/createRoom', a.access_token!, {
      invite: [b.user_id],
      initial_state: [{
        type: 'm.room.history_visibility',
        content: { history_visibility: 'joined' },
      }],
    })).room_id,
  );
  const base = 'v3/rooms/' + encodeURIComponent(room);
  const hidden = String(
    (await ok(base + '/send/m.room.message/hidden', a.access_token!, {
      msgtype: 'm.text',
      body: 'before join',
    }, 'PUT')).event_id,
  );
  await ok(base + '/join', b.access_token!, {});
  const visible = String(
    (await ok(base + '/send/m.room.message/visible', a.access_token!, {
      msgtype: 'm.text',
      body: 'after join',
    }, 'PUT')).event_id,
  );
  await ok(base + '/read_markers', b.access_token!, {
    'm.fully_read': visible,
  });
  assertEquals(
    (await call(base + '/event/' + encodeURIComponent(hidden), b.access_token!))
      .status,
    404,
  );
  for (const event of [hidden, '$unknown:localhost']) {
    for (const receipt of [true, false]) {
      const response = await call(
        base +
          (receipt
            ? '/receipt/m.fully_read/' + encodeURIComponent(event)
            : '/read_markers'),
        b.access_token!,
        receipt ? {} : { 'm.fully_read': event },
      );
      assertEquals(response.status, 404);
      assertEquals(response.body.errcode, 'M_NOT_FOUND');
      const marker = await ok(
        'v3/user/' + encodeURIComponent(b.user_id) + '/rooms/' +
          encodeURIComponent(room) + '/account_data/m.fully_read',
        b.access_token!,
      );
      assertEquals(marker.event_id, visible);
    }
  }
});

suite.test('both fully-read routes accept room-owned events before the server projection catches up', async () => {
  const f = await setup('marker-projection-lag');
  // Model the durable room commit / failed server projection boundary. The
  // event is still readable from room truth, just as committed history is.
  await theApp().server.execute('DELETE FROM event_index WHERE event=?', [
    f.root,
  ]);
  assertEquals((await f.event()).event_id, f.root);
  await ok(
    f.base + '/receipt/m.fully_read/' + encodeURIComponent(f.root),
    f.b.access_token!,
    {},
  );
  await ok(f.base + '/read_markers', f.b.access_token!, {
    'm.fully_read': f.root,
  });
  const marker = await ok(
    'v3/user/' + encodeURIComponent(f.b.user_id) + '/rooms/' +
      encodeURIComponent(f.room) + '/account_data/m.fully_read',
    f.b.access_token!,
  );
  assertEquals(marker.event_id, f.root);
});

suite.test('cross-room and unknown-parent relations never appear under a held parent', async () => {
  const f = await setup('relation-cross-room');
  const other = await setup('relation-cross-room-other');
  await other.send('cross', other.relation(f.root));
  await f.send('unknown', f.relation('$unknown:localhost'));
  assertEquals(ids(await f.page()), []);
  assertEquals(ids(await ok(f.v1 + '/threads', f.b.access_token!)), []);
});
