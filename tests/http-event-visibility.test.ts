// F14: one event-DAG visibility contract at every client timeline consumer.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { stateAtSeq } from '#engine/client/read.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP event-DAG visibility');
type Json = Record<string, unknown>;
let alice: { user_id: string; access_token?: string };
let bob: { user_id: string; access_token?: string };
let roomId: string, root: string, hidden: string, visible: string;
let newerRoot: string, hiddenOnlyRoot: string;
let transitionRoom: string, tightening: string, invite: string;
const base = (id: string) => 'rooms/' + encodeURIComponent(id);
async function call(
  path: string,
  token = bob.access_token,
  method = 'GET',
  body?: unknown,
  version = 'v3',
) {
  const res = await suite.matrix(
    new Request('http://x/_matrix/client/' + version + '/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}
async function ok(
  path: string,
  token = bob.access_token,
  method = 'GET',
  body?: unknown,
  version = 'v3',
) {
  const res = await call(path, token, method, body, version);
  assertEquals(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const ids = (events: unknown) => (events as Json[]).map((e) => e.event_id);
const bundle = (event: Json) =>
  ((event.unsigned as Json)['m.relations'] as Json)?.['m.thread'] as
    | Json
    | undefined;

suite.test('fixture: event membership and publication membership genuinely disagree on a delayed fork', async () => {
  alice = await suite.registerTestUser('f14-alice', 'pw');
  bob = await suite.registerTestUser('f14-bob', 'pw');
  roomId = String(
    (await ok('createRoom', alice.access_token, 'POST', {
      preset: 'public_chat',
      initial_state: [{
        type: 'm.room.history_visibility',
        content: { history_visibility: 'joined' },
      }],
    })).room_id,
  );
  const room = await openRoom(theApp().store, roomId);
  const signer = theApp().tenant.signer();
  const say = async (body: string, prev?: string[], relates?: string) => {
    const sent = await sendLocal(room, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: {
        body,
        msgtype: 'm.text',
        ...(relates
          ? { 'm.relates_to': { rel_type: 'm.thread', event_id: relates } }
          : {}),
      },
      ...(prev ? { prev_events: prev } : {}),
    }, signer);
    assertEquals(sent.standing, 'accepted');
    return sent.eventId;
  };
  const preJoin = await say('before join');
  await ok(base(roomId) + '/join', bob.access_token, 'POST', {});
  root = await say('visible root');
  visible = await say('visible child', undefined, root);
  hidden = await say('unreadable delayed fork', [preJoin], root);
  newerRoot = await say('newer visible root');
  await say('newer visible child', undefined, newerRoot);
  await say('unreadable newest reply', [preJoin], root);
  hiddenOnlyRoot = await say('visible root with hidden-only replies');
  await say('unreadable only reply', [preJoin], hiddenOnlyRoot);
  const seq = Number(
    (await theApp().server.query('SELECT seq FROM feed WHERE event=?', [
      hidden,
    ]))[0].seq,
  );
  const published = await stateAtSeq(room, seq);
  assertEquals(
    published.find((r) =>
      r.type === 'm.room.member' && r.stateKey === bob.user_id
    )?.content.membership,
    'join',
  );
  await room.tx(async (tx) => {
    const refs = await tx.state.eventReadState(hidden);
    assert(refs !== null);
    assertEquals(
      await tx.state.groupKey(refs.after.group, 'm.room.member', bob.user_id),
      null,
    );
  });
  transitionRoom = String(
    (await ok('createRoom', alice.access_token, 'POST', {
      preset: 'public_chat',
      initial_state: [{
        type: 'm.room.history_visibility',
        content: { history_visibility: 'world_readable' },
      }],
    })).room_id,
  );
  tightening = String(
    (await ok(
      base(transitionRoom) + '/state/m.room.history_visibility',
      alice.access_token,
      'PUT',
      { history_visibility: 'joined' },
    )).event_id,
  );
  invite = String(
    (await ok(
      base(transitionRoom) + '/state/m.room.member/' +
        encodeURIComponent(bob.user_id),
      alice.access_token,
      'PUT',
      { membership: 'invite' },
    )).event_id,
  );
  await ok(base(transitionRoom) + '/join', bob.access_token, 'POST', {});
  await ok(
    base(transitionRoom) + '/send/m.room.message/marker',
    alice.access_token,
    'PUT',
    { body: 'transition-search-marker', msgtype: 'm.text' },
  );
});

suite.test('sync timeline uses event refs; its state and unsigned membership remain publication-based', async () => {
  const sync = await ok(
    'sync?timeout=0&filter=' +
      encodeURIComponent(
        JSON.stringify({ room: { timeline: { limit: 100 } } }),
      ),
  );
  const joined = (sync.rooms as Json).join as Json;
  const timeline = ((joined[roomId] as Json).timeline as Json).events as Json[];
  assert(
    !ids(timeline).includes(hidden),
    'delayed fork must not be visible through its receipt-time publication',
  );
  assert(ids(timeline).includes(visible));
  assertEquals(
    (timeline.find((e) => e.event_id === visible)!.unsigned as Json).membership,
    'join',
  );
  assert(
    ids(((joined[transitionRoom] as Json).timeline as Json).events).includes(
      tightening,
    ),
    'world-readable before-state makes the transition visible',
  );
});

suite.test('event endpoint includes before-visible transitions but not an own invite with neither side visible', async () => {
  assertEquals(
    (await call(base(roomId) + '/event/' + encodeURIComponent(hidden))).status,
    404,
  );
  assertEquals(
    (await call(
      base(transitionRoom) + '/event/' + encodeURIComponent(tightening),
    )).status,
    200,
  );
  assertEquals(
    (await call(base(transitionRoom) + '/event/' + encodeURIComponent(invite)))
      .status,
    404,
  );
});

suite.test('messages evaluates before-or-after transitions and excludes delayed hidden events', async () => {
  const page = await ok(base(transitionRoom) + '/messages?dir=b&limit=100');
  assert(ids(page.chunk).includes(tightening));
  const fork = await ok(base(roomId) + '/messages?dir=b&limit=100');
  assert(!ids(fork.chunk).includes(hidden));
  assert(ids(fork.chunk).includes(visible));
});

suite.test('context uses the same transition visibility at the pivot and its neighboring timeline', async () => {
  const ctx = await ok(
    base(transitionRoom) + '/context/' + encodeURIComponent(tightening) +
      '?limit=100',
  );
  assertEquals((ctx.event as Json).event_id, tightening);
  const fork = await ok(
    base(roomId) + '/context/' + encodeURIComponent(root) + '?limit=100',
  );
  assert(!ids(fork.events_after).includes(hidden));
});

suite.test('relations filters every path and denies hidden roots; pagination does not count hidden children', async () => {
  for (const suffix of ['', '/m.thread', '/m.thread/m.room.message']) {
    const page = await ok(
      base(roomId) + '/relations/' + encodeURIComponent(root) + suffix +
        '?dir=f&limit=1',
      undefined,
      'GET',
      undefined,
      'v1',
    );
    assertEquals(ids(page.chunk), [visible]);
    assertEquals(page.next_batch, undefined);
    assertEquals(
      (await call(
        base(roomId) + '/relations/' + encodeURIComponent(hidden) + suffix,
        undefined,
        'GET',
        undefined,
        'v1',
      )).status,
      404,
    );
  }
});

suite.test('thread bundles and thread lists expose only visible children and their visible latest event', async () => {
  const event = await ok(base(roomId) + '/event/' + encodeURIComponent(root));
  assertEquals(bundle(event)?.count, 1);
  assertEquals((bundle(event)?.latest_event as Json).event_id, visible);
  const threads = await ok(
    base(roomId) + '/threads',
    undefined,
    'GET',
    undefined,
    'v1',
  );
  const shown = (threads.chunk as Json[]).find((e) => e.event_id === root)!;
  assertEquals(bundle(shown)?.count, 1);
  assert(!ids(threads.chunk).includes(hiddenOnlyRoot));
  const page = await ok(
    base(roomId) + '/threads?limit=1',
    undefined,
    'GET',
    undefined,
    'v1',
  );
  assertEquals(ids(page.chunk), [newerRoot]);
  const next = await ok(
    base(roomId) + '/threads?limit=1&from=' + page.next_batch,
    undefined,
    'GET',
    undefined,
    'v1',
  );
  assertEquals(ids(next.chunk), [root]);
});

suite.test('own membership is tested before-or-after, never allowed solely because the state key is ours', async () => {
  assertEquals(
    (await call(base(transitionRoom) + '/event/' + encodeURIComponent(invite)))
      .status,
    404,
  );
});

suite.test('unrecognized history visibility has the same shared default across sync, search and event reads', async () => {
  const made = await ok('createRoom', alice.access_token, 'POST', {
    preset: 'public_chat',
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'future-unknown' },
    }],
  });
  const id = String(made.room_id);
  const sent = await ok(
    base(id) + '/send/m.room.message/default',
    alice.access_token,
    'PUT',
    { body: 'unknown-visibility-marker', msgtype: 'm.text' },
  );
  await ok(base(id) + '/join', bob.access_token, 'POST', {});
  assertEquals(
    (await call(
      base(id) + '/event/' + encodeURIComponent(String(sent.event_id)),
    )).status,
    200,
  );
  const found = await ok('search', undefined, 'POST', {
    search_categories: {
      room_events: { search_term: 'unknown-visibility-marker' },
    },
  });
  assertEquals(
    ((found.search_categories as Json).room_events as Json).count,
    1,
  );
  const sync = await ok('sync?timeout=0');
  const joined = (sync.rooms as Json).join as Json;
  assert(
    ids(((joined[id] as Json).timeline as Json).events).includes(sent.event_id),
  );
});

suite.test('search applies event visibility to hits and before-visible transitions in event context', async () => {
  const search = async (term: string, room: string) => {
    const found = await ok('search', undefined, 'POST', {
      search_categories: {
        room_events: {
          search_term: term,
          filter: { rooms: [room] },
          event_context: { before_limit: 100, after_limit: 100 },
        },
      },
    });
    return (found.search_categories as Json).room_events as Json;
  };
  assertEquals((await search('unreadable', roomId)).count, 0);
  const found = await search('transition-search-marker', transitionRoom);
  assertEquals(found.count, 1);
  const context = (found.results as Json[])[0].context as Json;
  assert(ids(context.events_before).includes(tightening));
});

suite.test('membership join-to-leave and visibility loosening remain visible through the same helper', async () => {
  const left = await ok(
    base(transitionRoom) + '/state/m.room.member/' +
      encodeURIComponent(bob.user_id),
    bob.access_token,
    'PUT',
    { membership: 'leave' },
  );
  assertEquals(
    (await call(
      base(transitionRoom) + '/event/' +
        encodeURIComponent(String(left.event_id)),
    )).status,
    200,
  );
  const loosened = await ok(
    base(transitionRoom) + '/state/m.room.history_visibility',
    alice.access_token,
    'PUT',
    { history_visibility: 'world_readable' },
  );
  assertEquals(
    (await call(
      base(transitionRoom) + '/event/' +
        encodeURIComponent(String(loosened.event_id)),
    )).status,
    200,
  );
});

suite.test('shared history requires a join, and departure denies later events until a qualifying rejoin', async () => {
  const observed: { case: string; actual: number; expected: number }[] = [];
  const expectStatus = async (
    id: string,
    event: string,
    expected: number,
    label: string,
  ) => {
    for (const endpoint of ['event', 'context']) {
      observed.push({
        case: label + '/' + endpoint,
        actual: (await call(base(id) + '/' + endpoint + '/' + event)).status,
        expected,
      });
    }
  };
  for (const hv of ['shared', 'future-unknown']) {
    const id = String(
      (await ok('createRoom', alice.access_token, 'POST', {
        preset: 'public_chat',
        initial_state: [{
          type: 'm.room.history_visibility',
          content: { history_visibility: hv },
        }],
      })).room_id,
    );
    const say = async (name: string) =>
      String(
        (await ok(
          base(id) + '/send/m.room.message/' + name,
          alice.access_token,
          'PUT',
          { body: name, msgtype: 'm.text' },
        )).event_id,
      );
    const before = await say('before-join');
    const member = base(id) + '/state/m.room.member/' +
      encodeURIComponent(bob.user_id);
    await ok(member, alice.access_token, 'PUT', { membership: 'invite' });
    await expectStatus(id, before, 404, hv + '/invited-only');
    await ok(base(id) + '/leave', bob.access_token, 'POST', {});
    await expectStatus(id, before, 404, hv + '/rejected-invite');
    await ok(base(id) + '/join', bob.access_token, 'POST', {});
    await ok(base(id) + '/leave', bob.access_token, 'POST', {});
    const afterLeave = await say('after-leave');
    await expectStatus(id, before, 200, hv + '/prejoin-after-leave');
    await expectStatus(id, afterLeave, 404, hv + '/post-leave');
    await ok(base(id) + '/join', bob.access_token, 'POST', {});
    await expectStatus(id, afterLeave, 200, hv + '/qualifying-rejoin');
    await ok(member, alice.access_token, 'PUT', { membership: 'ban' });
    const afterBan = await say('after-ban');
    await expectStatus(id, before, 200, hv + '/prejoin-after-ban');
    await expectStatus(id, afterLeave, 200, hv + '/rejoin-history-after-ban');
    await expectStatus(id, afterBan, 404, hv + '/post-ban');
  }
  assertEquals(
    observed.map((row) => [row.case, row.actual]),
    observed.map((row) => [row.case, row.expected]),
  );
});
