import { assert, assertEquals, assertRejects } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { receiveInvite } from '#engine/federation/invites.ts';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP native sliding sync');
const route = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';
const object = (value: unknown) => value as Json;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(
  path: string,
  token: string | undefined,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      signal,
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

async function fixture(prefix: string) {
  const app = theApp();
  const alice = await suite.registerTestUser(prefix + '-alice', 'pw');
  const bob = await suite.registerTestUser(prefix + '-bob', 'pw');
  const signer = app.tenant.signer();
  const room = (await createRoom(app.store, {
    creator: alice.user_id,
    name: 'Selected room',
  }, signer)).roomId;
  const send = (id: string, type: string, content: Json, key?: string) =>
    openRoom(app.store, id).then((room) =>
      sendLocal(room, {
        type,
        sender: alice.user_id,
        content,
        ...(key === undefined ? {} : { state_key: key }),
      }, signer)
    );
  const request: Json = {
    conn_id: 'room-list',
    lists: {
      main: {
        ranges: [[0, 19]],
        required_state: [['m.room.encryption', ''], ['m.room.member', '*']],
        timeline_limit: 10,
      },
    },
  };
  const sync = (
    body: Json = request,
    pos?: unknown,
    timeout = 0,
    signal?: AbortSignal,
    token = alice.access_token!,
  ) => {
    const query = new URLSearchParams({ timeout: String(timeout) });
    if (pos !== undefined) query.set('pos', String(pos));
    return call(route + '?' + query, token, body, 'POST', signal);
  };
  return { app, alice, bob, room, signer, send, request, sync };
}

suite.test('authentication, position ownership and discovery remain honest at the real endpoint', async () => {
  const f = await fixture('http-sliding-auth');
  assertEquals((await call(route, undefined, {})).status, 401);
  assertEquals((await f.sync({ lists: [] })).status, 400);
  const first = await f.sync();
  assertEquals(first.status, 200);
  assertEquals(typeof first.body.pos, 'string');
  assertEquals(
    (await f.sync(f.request, 'unissued')).body.errcode,
    'M_UNKNOWN_POS',
  );
  assertEquals(
    (await f.sync(f.request, first.body.pos, 0, undefined, f.bob.access_token!))
      .body.errcode,
    'M_UNKNOWN_POS',
  );
  assertEquals(
    (await f.sync({ ...f.request, conn_id: 'encryption' }, first.body.pos)).body
      .errcode,
    'M_UNKNOWN_POS',
  );
  const versions = await call(
    '/_matrix/client/versions',
    undefined,
    undefined,
    'GET',
  );
  assertEquals(
    object(versions.body.unstable_features)['org.matrix.simplified_msc3575'],
    true,
  );
});

suite.test('list windows, subscriptions and invite display reach independent SDK-shaped connections', async () => {
  const f = await fixture('http-sliding-lists');
  const empty = (await createRoom(f.app.store, {
    creator: f.alice.user_id,
    name: 'Empty room',
  }, f.signer)).roomId;
  await f.send(
    f.room,
    'm.room.member',
    { membership: 'invite' },
    f.bob.user_id,
  );
  const first = await f.sync();
  assertEquals(first.status, 200);
  const lists = object(first.body.lists), main = object(lists.main);
  assertEquals(main.count, 2);
  const rooms = object(first.body.rooms);
  assertEquals(object(rooms[f.room]).name, 'Selected room');
  assertEquals(object(rooms[empty]).name, 'Empty room');
  const encrypted = await f.sync({
    conn_id: 'encryption',
    extensions: { e2ee: { enabled: true }, to_device: { enabled: true } },
  });
  assertEquals(encrypted.status, 200);
  assertEquals(encrypted.body.rooms, {});
  assertEquals(encrypted.body.lists, {});
  const invite = await f.sync(
    f.request,
    undefined,
    0,
    undefined,
    f.bob.access_token!,
  );
  assertEquals(invite.status, 200);
  const invited = object(object(invite.body.rooms)[f.room]);
  assert(Array.isArray(invited.invite_state));
  assertEquals(invited.timeline, undefined);
  assertEquals(invited.required_state, undefined);
});

suite.test('room-list positions and another connection receipt cannot consume encryption inbox pages', async () => {
  const f = await fixture('http-sliding-inbox');
  const messages = {
    [f.alice.user_id]: {
      [f.alice.device_id!]: { body: 'client-compat-inbox-first' },
    },
  };
  assertEquals(
    (await call(
      '/_matrix/client/v3/sendToDevice/org.example.proof/first',
      f.bob.access_token!,
      { messages },
      'PUT',
    )).status,
    200,
  );
  const list = await f.sync();
  const encrypted = {
    conn_id: 'encryption',
    extensions: { to_device: { enabled: true, limit: 1 } },
  };
  const first = await f.sync(encrypted);
  assertEquals(first.status, 200);
  const page = object(object(first.body.extensions).to_device);
  assertEquals(
    object((page.events as Json[])[0].content).body,
    'client-compat-inbox-first',
  );
  const listReceipt = await f.sync({
    conn_id: 'room-list',
    extensions: {
      to_device: { enabled: true, limit: 1, since: page.next_batch },
    },
  }, list.body.pos);
  assertEquals(listReceipt.status, 200);
  assertEquals(
    object(
      (object(object(listReceipt.body.extensions).to_device).events as Json[])[
        0
      ].content,
    ).body,
    'client-compat-inbox-first',
  );
  messages[f.alice.user_id][f.alice.device_id!].body =
    'client-compat-inbox-tail';
  assertEquals(
    (await call(
      '/_matrix/client/v3/sendToDevice/org.example.proof/tail',
      f.bob.access_token!,
      { messages },
      'PUT',
    )).status,
    200,
  );
  const next = await f.sync({
    ...encrypted,
    extensions: {
      to_device: { enabled: true, limit: 1, since: page.next_batch },
    },
  }, first.body.pos);
  assertEquals(next.status, 200);
  assertEquals(
    object(
      (object(object(next.body.extensions).to_device).events as Json[])[0]
        .content,
    ).body,
    'client-compat-inbox-tail',
  );
});

suite.test('pending remote invite account data is delivered before its room cut advances', async () => {
  const f = await fixture('http-sliding-prejoin-data');
  const remote = await makeRemoteServer('remote.test');
  const room = '!sliding-account:remote.test';
  const event = await remoteEvent(room, remote, '11', {
    type: 'm.room.member',
    state_key: f.alice.user_id,
    sender: '@zoe:remote.test',
    content: { membership: 'invite' },
    prev_events: [],
    auth_events: [],
  });
  await receiveInvite(
    room,
    event.event_id!,
    {
      room_version: '11',
      event: wireOf(event),
      invite_room_state: [],
    },
    remote.name,
    {
      store: f.app.store,
      server: f.app.server,
      signer: f.signer,
      keys: fakeKeyResolver(remote),
      self: 'localhost',
      wake: () => {},
    },
  );
  assertEquals(
    (await call(
      '/_matrix/client/v3/user/' + encodeURIComponent(f.alice.user_id) +
        '/rooms/' + encodeURIComponent(room) +
        '/account_data/org.example.invite',
      f.alice.access_token!,
      { before_join: true },
      'PUT',
    )).status,
    200,
  );
  const request = {
    ...f.request,
    extensions: { account_data: { enabled: true } },
  };
  const first = await f.sync(request);
  assertEquals(first.status, 200);
  assertEquals(object(object(first.body.rooms)[room]).initial, true);
  const data = object(object(first.body.extensions).account_data);
  assertEquals(object(data.rooms)[room], [{
    type: 'org.example.invite',
    content: { before_join: true },
  }]);
  const next = await f.sync(request, first.body.pos);
  assertEquals(
    object(object(object(next.body.extensions).account_data).rooms)[room],
    undefined,
  );
});

suite.test('unrelated changes do not finish a selected-room poll, but room account data does without a timeline event', async () => {
  const f = await fixture('http-sliding-wake');
  const request = {
    conn_id: 'selected',
    room_subscriptions: { [f.room]: { required_state: [], timeline_limit: 0 } },
    extensions: { account_data: { enabled: true } },
  };
  const first = await f.sync(request);
  assertEquals(first.status, 200);
  let settled = false;
  const pending = f.sync(request, first.body.pos, 2000).then((value) => {
    settled = true;
    return value;
  });
  await wait(50);
  assertEquals(settled, false);
  assertEquals(
    (await call(
      '/_matrix/client/v3/user/' + encodeURIComponent(f.bob.user_id) +
        '/account_data/org.example.unrelated',
      f.bob.access_token!,
      { value: 1 },
      'PUT',
    )).status,
    200,
  );
  await wait(50);
  assertEquals(settled, false);
  assertEquals(
    (await call(
      '/_matrix/client/v3/user/' + encodeURIComponent(f.alice.user_id) +
        '/rooms/' + encodeURIComponent(f.room) +
        '/account_data/org.example.selected',
      f.alice.access_token!,
      { value: 2 },
      'PUT',
    )).status,
    200,
  );
  const result = await pending;
  assertEquals(result.status, 200);
  const data = object(object(result.body.extensions).account_data);
  assertEquals(
    (object(data.rooms)[f.room] as Json[]).find((row) =>
      row.type === 'org.example.selected'
    )?.content,
    { value: 2 },
  );
});

suite.test('typing starts and stops and public receipts wake selected-room polls without timeline delivery', async () => {
  const f = await fixture('http-sliding-ephemeral');
  await f.send(
    f.room,
    'm.room.member',
    { membership: 'invite' },
    f.bob.user_id,
  );
  const roomPath = '/_matrix/client/v3/rooms/' + encodeURIComponent(f.room);
  assertEquals(
    (await call(roomPath + '/join', f.bob.access_token!, {})).status,
    200,
  );
  const target = await f.send(f.room, 'm.room.topic', {
    topic: 'Receipt target',
  }, '');
  const request = {
    conn_id: 'streams',
    room_subscriptions: { [f.room]: { required_state: [], timeline_limit: 0 } },
    extensions: { receipts: { enabled: true }, typing: { enabled: true } },
  };
  const first = await f.sync(request);
  assertEquals(first.status, 200);
  const typingPath = roomPath + '/typing/' + encodeURIComponent(f.bob.user_id);
  const started = f.sync(request, first.body.pos, 2000);
  await wait(50);
  assertEquals(
    (await call(typingPath, f.bob.access_token!, {
      typing: true,
      timeout: 10000,
    }, 'PUT')).status,
    200,
  );
  const typing = await started;
  assertEquals(typing.status, 200);
  assertEquals(
    object(object(object(object(typing.body.extensions).typing).rooms)[f.room])
      .content,
    { user_ids: [f.bob.user_id] },
  );
  const receiptWait = f.sync(request, typing.body.pos, 2000);
  await wait(50);
  assertEquals(
    (await call(
      roomPath + '/receipt/m.read/' + encodeURIComponent(target.eventId),
      f.bob.access_token!,
      {},
    )).status,
    200,
  );
  const receipts = await receiptWait;
  assertEquals(receipts.status, 200);
  const content = object(
    object(
      object(object(object(receipts.body.extensions).receipts).rooms)[f.room],
    ).content,
  );
  assert(object(object(content[target.eventId])['m.read'])[f.bob.user_id]);
  const stopWait = f.sync(request, receipts.body.pos, 2000);
  await wait(50);
  assertEquals(
    (await call(typingPath, f.bob.access_token!, { typing: false }, 'PUT'))
      .status,
    200,
  );
  const stopped = await stopWait;
  assertEquals(stopped.status, 200);
  assertEquals(
    object(object(object(object(stopped.body.extensions).typing).rooms)[f.room])
      .content,
    { user_ids: [] },
  );
});

suite.test('aborting a wait rejects promptly and leaves the input position usable', async () => {
  const f = await fixture('http-sliding-abort');
  const first = await f.sync();
  assertEquals(first.status, 200);
  const abort = new AbortController();
  const pending = f.sync(f.request, first.body.pos, 30000, abort.signal);
  await wait(50);
  abort.abort();
  await assertRejects(() => pending, DOMException);
  const retry = await f.sync(f.request, first.body.pos);
  assertEquals(retry.status, 200);
});

suite.test('acknowledged inbox pages do not keep encryption polls hot or consume on cancellation', async () => {
  const f = await fixture('http-sliding-inbox-poll');
  const send = (txn: string) =>
    call(
      '/_matrix/client/v3/sendToDevice/org.example.proof/' + txn,
      f.bob.access_token!,
      {
        messages: {
          [f.alice.user_id]: { [f.alice.device_id!]: { body: txn } },
        },
      },
      'PUT',
    );
  assertEquals((await send('ack-first')).status, 200);
  const request = {
    conn_id: 'encryption',
    extensions: { to_device: { enabled: true } },
  };
  const first = await f.sync(request);
  assertEquals(first.status, 200);
  const since = object(object(first.body.extensions).to_device).next_batch;
  const next = {
    ...request,
    extensions: { to_device: { enabled: true, since } },
  };
  const abort = new AbortController();
  let settled = false;
  const pending = f.sync(next, first.body.pos, 30000, abort.signal).finally(
    () => {
      settled = true;
    },
  );
  // Attach rejection handling before abort, preserving the real response promise.
  const rejected = assertRejects(() => pending, DOMException);
  await wait(100);
  assertEquals(
    settled,
    false,
    'a received page must not make every poll immediate',
  );
  abort.abort();
  await rejected;
  // The cancelled request must not have acknowledged its page. A no-since retry
  // of the same issued input still receives the original byte-identical message.
  const replay = await f.sync(request, first.body.pos);
  assertEquals(
    object(
      (object(object(replay.body.extensions).to_device).events as Json[])[0]
        .content,
    ).body,
    'ack-first',
  );
  const delivered = f.sync(next, replay.body.pos, 2000);
  await wait(50);
  assertEquals((await send('ack-tail')).status, 200);
  const result = await delivered;
  assertEquals(result.status, 200);
  assertEquals(
    (object(object(result.body.extensions).to_device).events as Json[])
      .map((event) => object(event.content).body),
    ['ack-tail'],
  );
});

suite.test('notification counts and count-only read changes reach zero-timeline room consumers', async () => {
  const f = await fixture('http-sliding-counts');
  await f.send(
    f.room,
    'm.room.member',
    { membership: 'invite' },
    f.bob.user_id,
  );
  const roomPath = '/_matrix/client/v3/rooms/' + encodeURIComponent(f.room);
  assertEquals(
    (await call(roomPath + '/join', f.bob.access_token!, {})).status,
    200,
  );
  const request = {
    conn_id: 'counts',
    room_subscriptions: { [f.room]: { required_state: [], timeline_limit: 0 } },
  };
  const first = await f.sync(request);
  assertEquals(object(object(first.body.rooms)[f.room]).notification_count, 0);
  const waiting = f.sync(request, first.body.pos, 2000);
  await wait(50);
  const message = await call(
    roomPath + '/send/m.room.message/count-proof',
    f.bob.access_token!,
    { msgtype: 'm.text', body: 'notification consumer proof' },
    'PUT',
  );
  assertEquals(message.status, 200);
  const received = await waiting;
  assertEquals(
    object(object(received.body.rooms)[f.room]).notification_count,
    1,
  );
  assertEquals(object(object(received.body.rooms)[f.room]).timeline, undefined);
  const readWait = f.sync(request, received.body.pos, 2000);
  await wait(50);
  assertEquals(
    (await call(
      roomPath + '/receipt/m.read/' +
        encodeURIComponent(String(message.body.event_id)),
      f.alice.access_token!,
      {},
    )).status,
    200,
  );
  const read = await readWait;
  assertEquals(object(object(read.body.rooms)[f.room]).notification_count, 0);
  assertEquals(object(object(read.body.rooms)[f.room]).timeline, undefined);
});
