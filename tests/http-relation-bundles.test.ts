import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openRoom } from '#engine/room/index.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP relation bundles');
async function call(
  path: string,
  token: string,
  body?: unknown,
  method?: string,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
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
const bundles = (event: Json) =>
  (event.unsigned as Json)?.['m.relations'] as Json | undefined;
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
  let txn = 0;
  const send = async (
    content: Json,
    token = a.access_token!,
    type = 'm.room.message',
  ) =>
    String(
      (await ok(base + '/send/' + type + '/' + ++txn, token, content, 'PUT'))
        .event_id,
    );
  const root = await send({ body: 'bundle-original', msgtype: 'm.text' });
  const related = (id: string, rel_type: string) => ({
    event_id: id,
    rel_type,
  });
  const edit = (id: string, body: string) => ({
    body: '* ' + body,
    msgtype: 'm.text',
    'm.new_content': { body, msgtype: 'm.emote' },
    'm.relates_to': related(id, 'm.replace'),
  });
  const event = (id = root, token = b.access_token!) =>
    ok(base + '/event/' + encodeURIComponent(id), token);
  const redact = (id: string) =>
    ok(
      base + '/redact/' + encodeURIComponent(id) + '/' + ++txn,
      a.access_token!,
      {},
      'PUT',
    );
  return { a, b, room, base, v1, send, root, related, edit, event, redact };
}

suite.test('latest valid replacement is a full event without replacing original content', async () => {
  const f = await setup('bundle-valid');
  const valid = await f.send(f.edit(f.root, 'valid'));
  await f.send(f.edit(f.root, 'wrong sender'), f.b.access_token!);
  await f.send(f.edit(f.root, 'wrong type'), f.a.access_token!, 'test.other');
  await f.send({
    body: 'missing content',
    'm.relates_to': f.related(f.root, 'm.replace'),
  });
  await f.send({ ...f.edit(f.root, 'null content'), 'm.new_content': null });
  await ok(
    f.base + '/state/m.room.message/state-edit',
    f.a.access_token!,
    f.edit(f.root, 'state edit'),
    'PUT',
  );
  await f.send(f.edit(valid, 'edit of edit'));
  const original = await f.event();
  assertEquals((original.content as Json).body, 'bundle-original');
  const replacement = bundles(original)?.['m.replace'] as Json;
  assertEquals(replacement?.event_id, valid);
  assertEquals(replacement?.type, 'm.room.message');
  assertEquals(replacement?.sender, f.a.user_id);
  assertEquals((replacement?.content as Json)?.['m.new_content'], {
    body: 'valid',
    msgtype: 'm.emote',
  });
  assertEquals(bundles(await f.event(valid)), undefined);
});

suite.test('edit selection uses origin timestamp and lexical event ID, not arrival order', async () => {
  const f = await setup('bundle-time');
  const room = await openRoom(theApp().store, f.room);
  const edits: { id: string; ts: number }[] = [];
  for (
    const [body, ts] of [['first', 900], ['second', 900], [
      'late-old',
      800,
    ]] as const
  ) {
    const result = await sendLocal(room, {
      type: 'm.room.message',
      sender: f.a.user_id,
      content: f.edit(f.root, body),
      origin_server_ts: ts,
    }, theApp().tenant.signer());
    edits.push({ id: result.eventId, ts });
  }
  const winner = edits.filter((e) => e.ts === 900).map((e) => e.id).sort().at(
    -1,
  )!;
  assertEquals(
    (bundles(await f.event())?.['m.replace'] as Json)?.event_id,
    winner,
  );
});

suite.test('redacted latest edits fall back and redacted originals omit only edit bundles', async () => {
  const f = await setup('bundle-redacted');
  const first = await f.send(f.edit(f.root, 'first'));
  const latest = await f.send(f.edit(f.root, 'latest'));
  const reference = await f.send({
    'm.relates_to': f.related(f.root, 'm.reference'),
  });
  await f.redact(latest);
  assertEquals(
    (bundles(await f.event())?.['m.replace'] as Json)?.event_id,
    first,
  );
  await f.redact(f.root);
  assertEquals((await f.event()).content, {});
  assertEquals(bundles(await f.event())?.['m.replace'], undefined);
  assertEquals(bundles(await f.event())?.['m.reference'], {
    chunk: [{ event_id: reference }],
  });
});

suite.test('state and annotation parents never acquire bundles; references filter ignored and redacted children', async () => {
  const f = await setup('bundle-reference');
  const state = String(
    (await ok(
      f.base + '/state/test.state',
      f.a.access_token!,
      { value: 1 },
      'PUT',
    )).event_id,
  );
  await f.send(
    f.edit(state, 'invalid state edit'),
    f.a.access_token!,
    'test.state',
  );
  await f.send({ 'm.relates_to': f.related(state, 'm.reference') });
  assertEquals(bundles(await f.event(state)), undefined);
  const reaction = await f.send(
    { 'm.relates_to': { ...f.related(f.root, 'm.annotation'), key: 'yes' } },
    f.a.access_token!,
    'm.reaction',
  );
  await f.send({ 'm.relates_to': f.related(reaction, 'm.reference') });
  assertEquals(bundles(await f.event(reaction)), undefined);
  const visible = await f.send({
    'm.relates_to': f.related(f.root, 'm.reference'),
  }, f.b.access_token!);
  const removed = await f.send({
    'm.relates_to': f.related(f.root, 'm.reference'),
  }, f.b.access_token!);
  await f.redact(removed);
  await f.send({ 'm.relates_to': f.related(f.root, 'm.reference') });
  await ok(
    'v3/user/' + encodeURIComponent(f.b.user_id) +
      '/account_data/m.ignored_user_list',
    f.b.access_token!,
    { ignored_users: { [f.a.user_id]: {} } },
    'PUT',
  );
  const ownRoot = await f.send({ body: 'own' }, f.b.access_token!);
  const ownReference = await f.send({
    'm.relates_to': f.related(ownRoot, 'm.reference'),
  }, f.b.access_token!);
  await f.send({ 'm.relates_to': f.related(ownRoot, 'm.reference') });
  assertEquals(bundles(await f.event(ownRoot))?.['m.reference'], {
    chunk: [{ event_id: ownReference }],
  });
  const relations = await ok(
    f.v1 + '/relations/' + encodeURIComponent(f.root) + '/m.reference',
    f.b.access_token!,
  );
  assertEquals((relations.chunk as Json[]).map((e) => e.event_id), [visible]);
});

suite.test('latest thread reply carries its own edit and reference bundles in the inherited event shape', async () => {
  const f = await setup('bundle-thread');
  const reply = await f.send({
    body: 'thread',
    'm.relates_to': f.related(f.root, 'm.thread'),
  });
  const edit = await f.send(f.edit(reply, 'edited thread'));
  const reference = await f.send({
    'm.relates_to': f.related(reply, 'm.reference'),
  });
  const sync = await ok('v3/sync?timeout=0', f.b.access_token!);
  const joined = ((sync.rooms as Json).join as Json)[f.room] as Json;
  const root = ((joined.timeline as Json).events as Json[]).find((e) =>
    e.event_id === f.root
  )!;
  const latest = (bundles(root)?.['m.thread'] as Json)?.latest_event as Json;
  assertEquals(latest?.event_id, reply);
  assertEquals('room_id' in latest, false);
  const nested = bundles(latest);
  assertEquals((nested?.['m.replace'] as Json)?.event_id, edit);
  assertEquals('room_id' in (nested!['m.replace'] as Json), false);
  assertEquals(nested?.['m.reference'], { chunk: [{ event_id: reference }] });
  assertEquals(nested?.['m.thread'], undefined);
});

suite.test('all client readers share edit/reference bundles including native sliding sync', async () => {
  const f = await setup('bundle-consumers');
  const edit = await f.send(f.edit(f.root, 'consumer edit'));
  const reference = await f.send({
    'm.relates_to': f.related(f.root, 'm.reference'),
  });
  const parent = await f.send({ body: 'relation parent' });
  const child = await f.send({
    body: 'relation child',
    'm.relates_to': f.related(parent, 'm.reference'),
  });
  const childEdit = await f.send(f.edit(child, 'child edit'));
  const check = (event: Json | undefined, expected = edit) => {
    assert(event, 'reader returned original event');
    assertEquals((bundles(event)?.['m.replace'] as Json)?.event_id, expected);
    if (expected === edit) {
      assertEquals(bundles(event)?.['m.reference'], {
        chunk: [{ event_id: reference }],
      });
    }
  };
  check(await f.event());
  check(
    ((await ok(f.base + '/messages?dir=b&limit=100', f.b.access_token!))
      .chunk as Json[]).find((e) => e.event_id === f.root),
  );
  check(
    (await ok(
      f.base + '/context/' + encodeURIComponent(f.root),
      f.b.access_token!,
    )).event as Json,
  );
  const search = await ok('v3/search', f.b.access_token!, {
    search_categories: { room_events: { search_term: 'bundle-original' } },
  });
  check(
    (((search.search_categories as Json).room_events as Json)
      .results as Json[])[0].result as Json,
  );
  const sync = await ok('v3/sync?timeout=0', f.b.access_token!);
  const joined = ((sync.rooms as Json).join as Json)[f.room] as Json;
  check(
    ((joined.timeline as Json).events as Json[]).find((e) =>
      e.event_id === f.root
    ),
  );
  const sliding = await ok(
    'unstable/org.matrix.simplified_msc3575/sync',
    f.b.access_token!,
    {
      room_subscriptions: {
        [f.room]: { required_state: [], timeline_limit: 100 },
      },
    },
  );
  check(
    (((sliding.rooms as Json)[f.room] as Json).timeline as Json[]).find((e) =>
      e.event_id === f.root
    ),
  );
  const relations = await ok(
    f.v1 + '/relations/' + encodeURIComponent(parent),
    f.b.access_token!,
  );
  check(
    (relations.chunk as Json[]).find((e) => e.event_id === child),
    childEdit,
  );
});

suite.test('encrypted edits bundle without requiring cleartext new content', async () => {
  const f = await setup('bundle-encrypted');
  const root = await f.send(
    { algorithm: 'test', ciphertext: 'original' },
    f.a.access_token!,
    'm.room.encrypted',
  );
  const edit = await f.send(
    {
      algorithm: 'test',
      ciphertext: 'replacement',
      'm.relates_to': f.related(root, 'm.replace'),
    },
    f.a.access_token!,
    'm.room.encrypted',
  );
  assertEquals(
    (bundles(await f.event(root))?.['m.replace'] as Json)?.event_id,
    edit,
  );
});

suite.test('duplicate annotations are atomic, retryable, type/sender/key scoped and released by redaction', async () => {
  const f = await setup('bundle-duplicate');
  const content = {
    'm.relates_to': { ...f.related(f.root, 'm.annotation'), key: 'yes' },
  };
  const path = f.base + '/send/m.reaction/';
  const first = await ok(path + 'first', f.a.access_token!, content, 'PUT');
  assertEquals(
    await ok(path + 'first', f.a.access_token!, content, 'PUT'),
    first,
  );
  const duplicate = await call(
    path + 'second',
    f.a.access_token!,
    content,
    'PUT',
  );
  assertEquals(duplicate.status, 400);
  assertEquals(duplicate.body.errcode, 'M_DUPLICATE_ANNOTATION');
  await f.send(content, f.b.access_token!, 'm.reaction');
  await f.send(content, f.a.access_token!, 'test.annotation');
  const other = {
    'm.relates_to': { ...f.related(f.root, 'm.annotation'), key: 'other' },
  };
  const concurrent = await Promise.all(
    ['race-a', 'race-b'].map((txn) =>
      call(path + txn, f.a.access_token!, other, 'PUT')
    ),
  );
  assertEquals(concurrent.map((r) => r.status).sort(), [200, 400]);
  await f.redact(String(first.event_id));
  await ok(path + 'after-redaction', f.a.access_token!, content, 'PUT');
});

suite.test('duplicate admission reads room truth even if server relation projection is missing', async () => {
  const f = await setup('bundle-duplicate-room');
  const content = {
    'm.relates_to': { ...f.related(f.root, 'm.annotation'), key: 'yes' },
  };
  const id = await f.send(content, f.a.access_token!, 'm.reaction');
  await theApp().server.execute('DELETE FROM relations WHERE event=?', [id]);
  const result = await call(
    f.base + '/send/m.reaction/duplicate',
    f.a.access_token!,
    content,
    'PUT',
  );
  assertEquals(result.status, 400);
  assertEquals(result.body.errcode, 'M_DUPLICATE_ANNOTATION');
});
