// Remaining doltgres contract rows: legacy wire shapes, full relation
// pagination, search's Complement rows and all three rule-migration doors.
import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP room compatibility');
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
  st = (id: string, type: string) => rp(id) + '/state/' + type;
async function create(token: string | undefined, body: Json = {}) {
  const res = await call('createRoom', token, body, 'POST');
  assertEquals(res.status, 200, JSON.stringify(res.body));
  return res.body.room_id as string;
}
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
const eventIds = (events: unknown) => (events as Json[]).map((e) => e.event_id);

test('legacy versions 3–9/11: create/PL/message/redaction wire shapes; v3 + or / survives the URL', async () => {
  const a = await registerTestUser('compat-legacy', 'pw');
  const A = a.access_token;
  for (const version of ['3', '4', '5', '6', '7', '8', '9', '11']) {
    const id = await create(A, { room_version: version });
    const content = (await call(st(id, 'm.room.create'), A)).body;
    assertEquals(content.room_version, version);
    assertEquals(
      content.creator,
      Number(version) <= 10 ? a.user_id : undefined,
    );
    assertEquals(
      ((await call(st(id, 'm.room.power_levels'), A)).body.users as Json)[
        a.user_id
      ],
      100,
    );
    const message = await send(id, A, 'hello v' + version),
      red = await call(
        rp(id) + '/redact/' + encodeURIComponent(message) + '/legacy-red',
        A,
        { reason: 'cleanup' },
      );
    assertEquals(red.status, 200);
    const rendered = await call(
      rp(id) + '/event/' + encodeURIComponent(String(red.body.event_id)),
      A,
    );
    assertEquals(rendered.status, 200);
    assertEquals(
      rendered.body.redacts,
      Number(version) <= 10 ? message : undefined,
    );
    assertEquals(
      (rendered.body.content as Json).redacts,
      Number(version) <= 10 ? undefined : message,
    );
    assertEquals((rendered.body.content as Json).reason, 'cleanup');
    const target = await call(
      rp(id) + '/event/' + encodeURIComponent(message),
      A,
    );
    assertEquals(target.body.content, {});
  }
  const room = await create(A, { room_version: '3' });
  let special: string | null = null;
  for (let i = 0; i < 30 && special === null; i++) {
    const id = await send(room, A, 'alphabet probe ' + i);
    if (/[+/]/.test(id)) special = id;
  }
  assertEquals(typeof special, 'string', 'no +// id in 30 messages');
  const got = await call(
    rp(room) + '/event/' + encodeURIComponent(special!),
    A,
  );
  assertEquals(got.status, 200);
  assertEquals(got.body.event_id, special);
});

test('relations: mixed event types/replacements, ten-child pages in both directions, full sync grammar and thread ordering', async () => {
  const a = await registerTestUser('compat-rel', 'pw'),
    b = await registerTestUser('compat-rel-other', 'pw');
  const A = a.access_token;
  const id = await create(A, { preset: 'public_chat' }),
    root = await send(id, A, 'root'),
    rel = (event: string, type = 'm.thread') => ({
      'm.relates_to': { event_id: event, rel_type: type },
    });
  const msg = await send(id, A, 'reply', rel(root)),
    dummy = await send(id, A, 'dummy', rel(root), 'm.dummy'),
    edit = await send(id, A, '* edited root', {
      ...rel(root, 'm.replace'),
      'm.new_content': { msgtype: 'm.text', body: 'edited root' },
    });
  const path = rp(id) + '/relations/' + encodeURIComponent(root),
    get = (path: string) => call(path, A, undefined, 'GET', 'v1');
  assertEquals(
    new Set(eventIds((await get(path)).body.chunk)),
    new Set([msg, dummy, edit]),
  );
  assertEquals(
    new Set(eventIds((await get(path + '/m.thread')).body.chunk)),
    new Set([msg, dummy]),
  );
  assertEquals(
    eventIds((await get(path + '/m.thread/m.room.message')).body.chunk),
    [msg],
  );
  const root2 = await send(id, A, 'root2'), ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    ids.push(await send(id, A, 'reply ' + i, rel(root2)));
  }
  const rel2 = rp(id) + '/relations/' + encodeURIComponent(root2),
    page1 = await get(rel2 + '?limit=3');
  assertEquals(eventIds(page1.body.chunk), [ids[9], ids[8], ids[7]]);
  assertEquals(
    eventIds(
      (await get(rel2 + '?limit=3&from=' + page1.body.next_batch)).body.chunk,
    ),
    [ids[6], ids[5], ids[4]],
  );
  const fwd1 = await get(rel2 + '?limit=3&dir=f');
  assertEquals(eventIds(fwd1.body.chunk), [ids[0], ids[1], ids[2]]);
  assertEquals(
    eventIds(
      (await get(rel2 + '?limit=3&dir=f&from=' + fwd1.body.next_batch)).body
        .chunk,
    ),
    [ids[3], ids[4], ids[5]],
  );
  const root3 = await send(id, A, 'root3');
  for (let i = 0; i < 5; i++) await send(id, A, 'before ' + i, rel(root3));
  const token = `s${await eventStreamMax(theApp().server)}_p0_t0_r0_a0`,
    after: string[] = [];
  for (let i = 0; i < 5; i++) {
    after.push(await send(id, A, 'after ' + i, rel(root3)));
  }
  assertEquals(
    eventIds(
      (await get(
        rp(id) + '/relations/' + encodeURIComponent(root3) +
          '?limit=3&dir=f&from=' + token,
      )).body.chunk,
    ),
    after.slice(0, 3),
  );
  const t1 = await send(id, A, 'Thread 1 Root'),
    t2 = await send(id, A, 'Thread 2 Root');
  await send(id, A, 'Thread 1 Reply', rel(t1));
  await send(id, A, 'Thread 2 Reply', rel(t2));
  const threads = rp(id) + '/threads';
  assertEquals(eventIds((await get(threads)).body.chunk).slice(0, 2), [t2, t1]);
  const latest = await send(id, A, 'Thread 1 Reply 2', rel(t1)),
    ordered = await get(threads);
  assertEquals(eventIds(ordered.body.chunk).slice(0, 2), [t1, t2]);
  const bundle = (((ordered.body.chunk as Json[])[0].unsigned as Json)[
    'm.relations'
  ] as Json)['m.thread'] as Json;
  assertEquals(bundle.count, 2);
  assertEquals((bundle.latest_event as Json).event_id, latest);
  const messages = await call(rp(id) + '/messages?dir=b&limit=20', A),
    rootEvent = (messages.body.chunk as Json[]).find((e) => e.event_id === t1)!;
  assert(
    ((rootEvent.unsigned as Json)['m.relations'] as Json)['m.thread'] !==
      undefined,
  );
  assertEquals(
    (await call(
      threads + '?include=participated',
      b.access_token,
      undefined,
      'GET',
      'v1',
    )).body.chunk,
    [],
  );
});

test('search: original body/context/20-result pagination/predecessor/keys/visibility/default-limit/shape rows', async () => {
  const a = await registerTestUser('compat-search', 'pw'),
    b = await registerTestUser('compat-search-b', 'pw');
  const A = a.access_token;
  const search = async (
    token: string | undefined,
    req: Json,
    next?: string,
  ) => {
    const res = await call(
      'search' +
        (next === undefined ? '' : '?next_batch=' + encodeURIComponent(next)),
      token,
      { search_categories: { room_events: req } },
      'POST',
    );
    assertEquals(res.status, 200);
    return (res.body.search_categories as Json).room_events as Json;
  };
  const id = await create(A), event = await send(id, A, 'hello, world');
  const body = await search(A, {
    keys: ['content.body'],
    search_term: 'hello',
    filter: { rooms: [id] },
  });
  assertEquals(body.count, 1);
  const hit = (body.results as Json[])[0].result as Json;
  assertEquals([
    hit.event_id,
    hit.room_id,
    (hit.content as Json).body,
    hit.type,
  ], [event, id, 'hello, world', 'm.room.message']);
  const contextRoom = await create(A);
  for (let i = 1; i <= 7; i++) {
    await send(contextRoom, A, 'Message number ' + i);
  }
  const context = await search(A, {
    keys: ['content.body'],
    search_term: 'Message 4',
    order_by: 'recent',
    filter: { limit: 1, rooms: [contextRoom] },
    event_context: { before_limit: 2, after_limit: 2 },
  });
  assertEquals(context.count, 1);
  assert(typeof context.next_batch === 'string');
  const row = (context.results as Json[])[0], ctx = row.context as Json;
  assertEquals((row.result as Json).content, {
    msgtype: 'm.text',
    body: 'Message number 4',
  });
  assertEquals(
    (ctx.events_before as Json[]).map((e) => (e.content as Json).body),
    ['Message number 3', 'Message number 2'],
  );
  assertEquals(
    (ctx.events_after as Json[]).map((e) => (e.content as Json).body),
    ['Message number 5', 'Message number 6'],
  );
  assertEquals(
    (await search(A, {
      keys: ['content.body'],
      search_term: 'number message',
      filter: { rooms: [contextRoom] },
    })).count,
    7,
  );
  const paged = await create(A), ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    ids.push(await send(paged, A, 'Message number ' + i));
  }
  const req = {
    keys: ['content.body'],
    search_term: 'Message',
    order_by: 'recent',
    filter: { limit: 10, rooms: [paged] },
  };
  const p1 = await search(A, req);
  assertEquals(p1.count, 20);
  assertEquals(
    (p1.results as Json[]).map((e) => (e.result as Json).event_id),
    ids.slice(10).reverse(),
  );
  const p2 = await search(A, req, p1.next_batch as string);
  assertEquals(p2.count, 20);
  assertEquals(
    (p2.results as Json[]).map((e) => (e.result as Json).event_id),
    ids.slice(0, 10).reverse(),
  );
  const p3 = await search(A, req, p2.next_batch as string);
  assertEquals(p3.count, 20);
  assertEquals(p3.results, []);
  assertEquals(p3.next_batch, undefined);
  const old = await create(A, { room_version: '8' }),
    beforeId = await send(old, A, 'Message before upgrade');
  const up = await call(rp(old) + '/upgrade', A, { new_version: '9' }, 'POST');
  assertEquals(up.status, 200);
  const next = up.body.replacement_room as string,
    afterId = await send(next, A, 'Message after upgrade');
  for (const rooms of [[old, next], [next]]) {
    const res = await search(A, {
      keys: ['content.body'],
      search_term: 'upgrade',
      filter: { rooms },
    });
    assertEquals(res.count, 2);
    assertEquals(
      new Set((res.results as Json[]).map((e) => (e.result as Json).event_id)),
      new Set([beforeId, afterId]),
    );
  }
  const named = await create(A, { name: 'UniqueSearchName' });
  for (
    const [key, count] of [['content.name', 1], ['content.body', 0]] as const
  ) {
    assertEquals(
      (await search(A, {
        keys: [key],
        search_term: 'UniqueSearchName',
        filter: { rooms: [named] },
      })).count,
      count,
    );
  }
  const privateHistory = await create(A, {
    preset: 'public_chat',
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'joined' },
    }],
  });
  await send(privateHistory, A, 'secret prejoin');
  await call(rp(privateHistory) + '/join', b.access_token, {}, 'POST');
  assertEquals(
    (await search(b.access_token, {
      keys: ['content.body'],
      search_term: 'secret prejoin',
      filter: { rooms: [privateHistory] },
    })).count,
    0,
  );
  const limited = await create(A);
  for (let i = 0; i < 15; i++) await send(limited, A, 'DefaultLimitNeedle');
  const limit = await search(A, {
    keys: ['content.body'],
    search_term: 'DefaultLimitNeedle',
    filter: { rooms: [limited] },
  });
  assertEquals(limit.count, 15);
  assertEquals((limit.results as Json[]).length, 10);
  assertEquals(limit.next_batch, undefined);
  await call('profile/' + encodeURIComponent(a.user_id) + '/displayname', A, {
    displayname: 'Search Alice',
  });
  const shape = await send(named, A, 'shape needle');
  const result = await search(A, {
    keys: ['content.body'],
    search_term: 'shape needle',
    filter: { rooms: [named] },
    include_state: true,
    groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
    event_context: { include_profile: true, before_limit: 0, after_limit: 0 },
  });
  assert(
    (result.state as Record<string, Json[]>)[named].some((e) =>
      e.type === 'm.room.create'
    ),
  );
  const groups = result.groups as Record<string, Record<string, Json>>;
  assertEquals(groups.room_id[named].results, [shape]);
  assertEquals(groups.sender[a.user_id].results, [shape]);
  assertEquals(typeof groups.room_id[named].order, 'number');
  assertEquals(
    (((result.results as Json[])[0].context as Json).profile_info as Record<
      string,
      Json
    >)[a.user_id].displayname,
    'Search Alice',
  );
  for (const order_by of ['rank', 'recent']) {
    const r = await create(A),
      red = await send(r, A, 'This message is going to be redacted'),
      visible = await send(r, A, 'This message is not going to be redacted');
    await call(rp(r) + '/redact/' + encodeURIComponent(red) + '/red', A, {
      reason: 'testing',
    });
    const res = await search(A, {
      keys: ['content.body'],
      order_by,
      search_term: 'redacted',
      filter: { rooms: [r] },
    });
    assertEquals(
      (res.results as Json[]).map((e) => (e.result as Json).event_id),
      [visible],
    );
  }
});

test('push-rule migration: all local users, manual predecessor/tombstone and join after the migration', async () => {
  const a = await registerTestUser('compat-migrate-a', 'pw'),
    b = await registerTestUser('compat-migrate-b', 'pw'),
    c = await registerTestUser('compat-migrate-c', 'pw');
  const A = a.access_token, B = b.access_token, C = c.access_token;
  const rule = (id: string) =>
      'pushrules/global/room/' + encodeURIComponent(id),
    put = (token: string | undefined, id: string) =>
      call(rule(id), token, { actions: ['dont_notify'] });
  const old = await create(A, {
    room_version: '10',
    preset: 'public_chat',
    invite: [b.user_id],
  });
  await call(rp(old) + '/join', B, {}, 'POST');
  await put(A, old);
  await put(B, old);
  const up = await call(rp(old) + '/upgrade', A, { new_version: '11' }, 'POST');
  assertEquals(up.status, 200);
  const next = up.body.replacement_room as string;
  await call(rp(next) + '/join', B, {}, 'POST');
  for (const token of [A, B]) {
    for (const id of [old, next]) {
      const res = await call(rule(id), token);
      assertEquals(res.status, 200);
      assertEquals(res.body.actions, ['dont_notify']);
    }
  }
  const old2 = await create(A, {
    room_version: '10',
    preset: 'public_chat',
    invite: [b.user_id],
  });
  await call(rp(old2) + '/join', B, {}, 'POST');
  await put(A, old2);
  await put(B, old2);
  const next2 = await create(A, {
    preset: 'public_chat',
    creation_content: { predecessor: { room_id: old2 } },
  });
  assertEquals((await call(rule(next2), A)).status, 200);
  await call(st(old2, 'm.room.tombstone'), A, {
    body: 'This room has been replaced',
    replacement_room: next2,
  });
  assertEquals((await call(rule(next2), B)).status, 200);
  await put(C, old2);
  assertEquals((await call(rule(next2), C)).status, 404);
  assertEquals((await call(rp(next2) + '/join', C, {}, 'POST')).status, 200);
  assertEquals((await call(rule(next2), C)).status, 200);
});
