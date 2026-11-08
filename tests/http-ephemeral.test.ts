// doltgres typing, receipt/read-marker and presence-on-join contracts.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';
import { eduQueues } from '#engine/federation/edus.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { seedServer } from '#tests/federation/doc-helper.ts';
import { wireEphemeral } from '#engine/federation/ephemeral.ts';
import { startSender } from '#engine/federation/sender.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { fakeFetcher, fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import { joinRemote } from '#engine/room/join.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP ephemeral streams');
async function call(
  path: string,
  token?: string,
  method = 'GET',
  body?: unknown,
) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
const sync = async (token: string, query = '') => {
  const result = await call('/_matrix/client/v3/sync?timeout=0' + query, token);
  assertEquals(result.status, 200);
  return result.body;
};
const entry = (body: Json, room: string) =>
  (((body.rooms as Json).join as Json)[room] ?? {}) as Json;
const ephemeral = (body: Json, room: string) =>
  ((entry(body, room).ephemeral as Json)?.events ?? []) as Json[];
const eventOf = (body: Json, room: string, type: string) =>
  ephemeral(body, room).find((e) => e.type === type);
async function roomFor(
  a: { access_token?: string; user_id: string },
  b: { access_token?: string; user_id: string },
) {
  const created = await call(
    '/_matrix/client/v3/createRoom',
    a.access_token!,
    'POST',
    { invite: [b.user_id] },
  );
  assertEquals(created.status, 200);
  const roomId = String(created.body.room_id);
  const base = '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId);
  assertEquals(
    (await call(base + '/join', b.access_token!, 'POST', {})).status,
    200,
  );
  return { roomId, base };
}

suite.test('typing starts/stops/expires, has no room_id, does not leak, and is per-user', async () => {
  const a = await suite.registerTestUser('ep-ty-a', 'pw');
  const b = await suite.registerTestUser('ep-ty-b', 'pw');
  const c = await suite.registerTestUser('ep-ty-c', 'pw');
  const { roomId, base } = await roomFor(a, b);
  const path = base + '/typing/' + encodeURIComponent(a.user_id);
  assertEquals(
    (await call(path, undefined, 'PUT', { typing: true })).status,
    401,
  );
  let before = await sync(b.access_token!, '&since=s0');
  assert(
    /^s\d+_p\d+_t\d+_r\d+_a\d+_d\d+_m\d+_k\d+$/.test(String(before.next_batch)),
  );
  for (
    const body of [{ typing: true, timeout: 10000 }, { typing: false }, {
      typing: true,
      timeout: 0,
    }]
  ) {
    assertEquals((await call(path, a.access_token!, 'PUT', body)).status, 200);
    const after = await sync(b.access_token!, '&since=' + before.next_batch);
    const typing = eventOf(after, roomId, 'm.typing');
    assert(typing !== undefined);
    assertEquals('room_id' in typing, false);
    assertEquals(
      (typing.content as Json).user_ids,
      body.typing && body.timeout !== 0 ? [a.user_id] : [],
    );
    before = after;
  }
  assertEquals(
    eventOf(
      await sync(b.access_token!, '&since=' + before.next_batch),
      roomId,
      'm.typing',
    ),
    undefined,
  );
  await call(path, a.access_token!, 'PUT', { typing: true, timeout: 10000 });
  assertEquals(entry(await sync(c.access_token!), roomId), {});
  const forbidden = await call(
    base + '/typing/' + encodeURIComponent(b.user_id),
    a.access_token!,
    'PUT',
    { typing: true },
  );
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.body.errcode, 'M_FORBIDDEN');
  await call(path, a.access_token!, 'PUT', { typing: false });
});

suite.test('receipts and read markers round-trip; private receipts stay stored and never broadcast', async () => {
  const a = await suite.registerTestUser('ep-rc-a', 'pw');
  const b = await suite.registerTestUser('ep-rc-b', 'pw');
  const { roomId, base } = await roomFor(a, b);
  const send = async (n: number) => {
    const r = await call(
      base + '/send/m.room.message/' + n,
      a.access_token!,
      'PUT',
      { msgtype: 'm.text', body: 'hi' },
    );
    assertEquals(r.status, 200);
    return String(r.body.event_id);
  };
  const receipt = (type: string, event: string) =>
    base + '/receipt/' + type + '/' + encodeURIComponent(event);
  const e1 = await send(1);
  assertEquals(
    (await call(receipt('m.read', e1), a.access_token!, 'POST', {})).status,
    200,
  );
  const initial = await sync(b.access_token!);
  const mark = eventOf(initial, roomId, 'm.receipt');
  assert(mark !== undefined);
  assertEquals('room_id' in mark, false);
  assertEquals(
    typeof ((((mark.content as Json)[e1] as Json)['m.read'] as Json)[
      a.user_id
    ] as Json).ts,
    'number',
  );
  const e2 = await send(2);
  assertEquals(
    (await call(receipt('m.read', e2), a.access_token!, 'POST', {})).status,
    200,
  );
  assert(
    eventOf(
      await sync(b.access_token!, '&since=' + initial.next_batch),
      roomId,
      'm.receipt',
    ),
  );
  const e3 = await send(3);
  assertEquals(
    (await call(base + '/read_markers', a.access_token!, 'POST', {
      'm.fully_read': e3,
      'm.read': e3,
    })).status,
    200,
  );
  const markers = await sync(a.access_token!);
  assertEquals(
    (((entry(markers, roomId).account_data as Json).events as Json[]).find((
      e,
    ) => e.type === 'm.fully_read')!.content as Json).event_id,
    e3,
  );
  assert(eventOf(markers, roomId, 'm.receipt'));
  const before = await sync(b.access_token!);
  const e4 = await send(4);
  assertEquals(
    (await call(receipt('m.read.private', e4), a.access_token!, 'POST', {}))
      .status,
    200,
  );
  const after = await sync(b.access_token!, '&since=' + before.next_batch);
  assertEquals(eventOf(after, roomId, 'm.receipt'), undefined);
  const rows = await theApp().server.query(
    "SELECT event_id FROM receipts WHERE room_id=? AND user_id=? AND receipt_type='m.read.private'",
    [roomId, a.user_id],
  );
  assertEquals(rows[0].event_id, e4);
  const bad = await call(
    receipt('m.fully_read', e4),
    a.access_token!,
    'POST',
    {},
  );
  assertEquals(bad.status, 400);
  assertEquals(bad.body.errcode, 'M_INVALID_PARAM');
  assertEquals(
    (await call(base + '/read_markers', a.access_token!, 'POST', {
      'm.fully_read': 12,
    })).status,
    400,
  );
});

for (const mode of ['selection', 'long poll']) {
  suite.test(
    'private receipts are excluded from peer sync ' + mode,
    async () => {
      const a = await suite.registerTestUser(
        'ep-private-a-' + mode.replace(' ', '-'),
        'pw',
      );
      const b = await suite.registerTestUser(
        'ep-private-b-' + mode.replace(' ', '-'),
        'pw',
      );
      const { roomId, base } = await roomFor(a, b);
      const sent = await call(
        base + '/send/m.room.message/private-target',
        a.access_token!,
        'PUT',
        { body: 'target' },
      );
      assertEquals(sent.status, 200);
      const target = encodeURIComponent(String(sent.body.event_id));
      const before = await sync(b.access_token!);
      const receipt = async (type: string) => {
        assertEquals(
          (await call(
            base + '/receipt/' + type + '/' + target,
            a.access_token!,
            'POST',
            {},
          )).status,
          200,
        );
      };
      if (mode === 'selection') {
        await receipt('m.read.private');
        const after = await sync(
          b.access_token!,
          '&since=' + before.next_batch,
        );
        assertEquals(entry(after, roomId), {});
        return;
      }
      let done = false;
      const pending = call(
        '/_matrix/client/v3/sync?timeout=2000&since=' + before.next_batch,
        b.access_token!,
      ).then((response) => {
        done = true;
        return response;
      });
      let stayedPending = false;
      let result: Awaited<ReturnType<typeof call>>;
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await receipt('m.read.private');
        await new Promise((resolve) => setTimeout(resolve, 150));
        stayedPending = !done;
      } finally {
        await receipt('m.read');
        result = await pending;
      }
      assertEquals(
        stayedPending,
        true,
        'private activity must not satisfy peer long-poll relevance',
      );
      assertEquals(result.status, 200);
      assert(eventOf(result.body, roomId, 'm.receipt'));
    },
  );
}

suite.test('room ephemeral admission rejects absent, invited and departed users across client producers', async () => {
  const a = await suite.registerTestUser('ep-admit-a', 'pw');
  const b = await suite.registerTestUser('ep-admit-b', 'pw');
  const { roomId, base } = await roomFor(a, b);
  const outsider = await suite.registerTestUser('ep-admit-out', 'pw');
  const before = await sync(a.access_token!);
  const denied = async (user: typeof outsider) => {
    const results = await Promise.all([
      call(
        base + '/receipt/m.read/%24forbidden',
        user.access_token!,
        'POST',
        {},
      ),
      call(
        base + '/receipt/m.read.private/%24forbidden',
        user.access_token!,
        'POST',
        {},
      ),
      call(base + '/read_markers', user.access_token!, 'POST', {
        'm.read': '$forbidden',
      }),
      call(
        base + '/typing/' + encodeURIComponent(user.user_id),
        user.access_token!,
        'PUT',
        { typing: true },
      ),
    ]);
    assertEquals(
      results.map((r) => [r.status, r.body.errcode]),
      Array(4).fill([403, 'M_FORBIDDEN']),
    );
  };
  await denied(outsider);
  assertEquals(
    (await call(base + '/invite', a.access_token!, 'POST', {
      user_id: outsider.user_id,
    })).status,
    200,
  );
  await denied(outsider);
  assertEquals(
    (await call(base + '/leave', b.access_token!, 'POST', {})).status,
    200,
  );
  await denied(b);
  assertEquals(
    (await call(base + '/ban', a.access_token!, 'POST', {
      user_id: outsider.user_id,
    })).status,
    200,
  );
  await denied(outsider);
  assertEquals(
    await theApp().server.query(
      'SELECT user_id FROM receipts WHERE room_id=?',
      [roomId],
    ),
    [],
  );
  const after = await sync(a.access_token!, '&since=' + before.next_batch);
  assertEquals(eventOf(after, roomId, 'm.receipt'), undefined);
  assertEquals(eventOf(after, roomId, 'm.typing'), undefined);
});

suite.test('inbound receipt admission cannot retain arbitrary room-user pairs or advance the stream', async () => {
  const app = theApp();
  const a = await suite.registerTestUser('ep-fed-deny', 'pw');
  const created = await call(
    '/_matrix/client/v3/createRoom',
    a.access_token!,
    'POST',
    {},
  );
  const roomId = String(created.body.room_id);
  const remote = await remoteServer('ep-unjoined.test');
  const fed = fedCaller(suite.matrix, remote);
  const before = await sync(a.access_token!);
  const content: Json = {};
  for (let i = 0; i < 12; i++) {
    const room = i === 0 ? roomId : '!arbitrary-' + i + ':' + remote.name;
    content[room] = {
      'm.read': {
        ['@unjoined-' + i + ':' + remote.name]: {
          event_ids: ['$forbidden'],
          data: { ts: i },
        },
      },
    };
  }
  const response = await fed(
    'PUT',
    '/_matrix/federation/v1/send/deny-arbitrary-receipts',
    {
      origin: remote.name,
      origin_server_ts: Date.now(),
      pdus: [],
      edus: [{ edu_type: 'm.receipt', content }],
    },
  );
  assertEquals(response, { status: 200, body: { pdus: {} } });
  assertEquals(
    await app.server.query(
      'SELECT user_id FROM receipts WHERE user_id LIKE ?',
      ['%:' + remote.name],
    ),
    [],
  );
  const after = await sync(a.access_token!, '&since=' + before.next_batch);
  assertEquals(
    String(after.next_batch).match(/_r\d+/)?.[0],
    String(before.next_batch).match(/_r\d+/)?.[0],
  );
  assertEquals(eventOf(after, roomId, 'm.receipt'), undefined);
});

suite.test('presence joins fan out both ways; status/set_presence validation and relevant wake', async () => {
  const a = await suite.registerTestUser('ep-pr-a', 'pw');
  const b = await suite.registerTestUser('ep-pr-b', 'pw');
  const c = await suite.registerTestUser('ep-pr-c', 'pw');
  const status = (u: string) =>
    '/_matrix/client/v3/presence/' + encodeURIComponent(u) + '/status';
  assertEquals(
    (await call(status(b.user_id), b.access_token!, 'PUT', {
      presence: 'online',
      status_msg: 'ready',
    })).status,
    200,
  );
  const created = await call(
    '/_matrix/client/v3/createRoom',
    a.access_token!,
    'POST',
    { preset: 'public_chat' },
  );
  const roomId = String(created.body.room_id);
  const aBefore = await sync(a.access_token!);
  const bBefore = await sync(b.access_token!);
  assertEquals(
    (await call(
      '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/join',
      b.access_token!,
      'POST',
      {},
    )).status,
    200,
  );
  const presence = (body: Json) => (body.presence as Json).events as Json[];
  assert(
    presence(await sync(a.access_token!, '&since=' + aBefore.next_batch)).some((
      e,
    ) => e.sender === b.user_id && (e.content as Json).presence === 'online'),
  );
  assert(
    presence(await sync(b.access_token!, '&since=' + bBefore.next_batch)).some((
      e,
    ) => e.sender === a.user_id),
  );
  assertEquals(
    (await call(status(b.user_id), a.access_token!, 'PUT', {
      presence: 'online',
    })).status,
    403,
  );
  assertEquals(
    (await call(status(a.user_id), a.access_token!, 'PUT', {})).body.errcode,
    'M_MISSING_PARAM',
  );
  assertEquals(
    (await call(status(a.user_id), a.access_token!, 'PUT', { presence: 'bad' }))
      .body.errcode,
    'M_INVALID_PARAM',
  );
  await sync(b.access_token!, '&set_presence=unavailable');
  const got = await call(status(b.user_id), a.access_token!);
  assertEquals(got.body.presence, 'unavailable');
  assertEquals(got.body.status_msg, 'ready');
  const before = await sync(a.access_token!);
  let done = false;
  const waiting = call(
    '/_matrix/client/v3/sync?timeout=3000&since=' + before.next_batch,
    a.access_token!,
  ).then((r) => {
    done = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 60));
  await call(status(c.user_id), c.access_token!, 'PUT', { presence: 'online' });
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(done, false);
  const start = performance.now();
  await call(status(b.user_id), b.access_token!, 'PUT', { presence: 'online' });
  const result = await waiting;
  assert(performance.now() - start < 450);
  assert(presence(result.body).some((e) => e.sender === b.user_id));
});

suite.test('sync presence changes preserve status and identical concurrent syncs do not rewrite or wake peers', async () => {
  const a = await suite.registerTestUser('ep-presence-stable-a', 'pw');
  const b = await suite.registerTestUser('ep-presence-stable-b', 'pw');
  await roomFor(a, b);
  const path = '/_matrix/client/v3/presence/' + encodeURIComponent(a.user_id) +
    '/status';
  await call(path, a.access_token!, 'PUT', {
    presence: 'online',
    status_msg: 'ready',
  });
  await sync(b.access_token!, '&set_presence=online');
  const original = await theApp().server.query(
    'SELECT * FROM presence WHERE user_id=?',
    [a.user_id],
  );
  await Promise.all(
    Array.from(
      { length: 4 },
      () => sync(a.access_token!, '&set_presence=online'),
    ),
  );
  assertEquals(
    await theApp().server.query('SELECT * FROM presence WHERE user_id=?', [
      a.user_id,
    ]),
    original,
  );
  const before = await sync(b.access_token!);
  let finished = false;
  const waiting = call(
    '/_matrix/client/v3/sync?timeout=1000&set_presence=online&since=' +
      before.next_batch,
    b.access_token!,
  ).then((r) => {
    finished = true;
    return r;
  });
  let stayedPending = false;
  try {
    await sync(a.access_token!, '&set_presence=online');
    await new Promise((resolve) => setTimeout(resolve, 80));
    stayedPending = !finished;
    await sync(a.access_token!, '&set_presence=unavailable');
  } finally {
    const changed = await waiting;
    assertEquals(
      stayedPending,
      true,
      'identical set_presence cannot wake a co-member',
    );
    const observed = ((changed.body.presence as Json).events as Json[]).find((
      e,
    ) => e.sender === a.user_id);
    assertEquals((observed?.content as Json)?.presence, 'unavailable');
    assertEquals((observed?.content as Json)?.status_msg, 'ready');
  }
});

suite.test('inbound EDU rows reach HTTP sync; local producers reach the sender, never private or remote echoes', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('ep-fed', 'pw');
  const previousCa = config().federation.cacerts;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const received: Json[] = [];
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: app.tenant.serverName,
        verify_keys: { [app.tenant.keyId]: { key: app.tenant.publicB64 } },
      }),
    handlers: (req) => {
      if (!req.path.startsWith('/_matrix/federation/v1/send/')) return null;
      assert(req.verified);
      received.push(req.json() as Json);
      return Response.json({ pdus: {} });
    },
  });
  const queues = eduQueues(
    (u) => u.endsWith(':localhost'),
    (d) => sender.wake(d),
  );
  const sender = startSender({
    store: app.store,
    signer: app.tenant.signer(),
    drainEdus: queues.drain,
  });
  const unwire = wireEphemeral(app.server, 'localhost', queues);
  try {
    const fr = await makeFakeRoom({
      roomId: '!ep-fed:' + fake.name,
      server: fake,
      joinRule: 'public',
    });
    const transport = fakeFetcher({
      makeJoin: (u) => fr.makeJoinAnswer(u),
      sendJoin: (p) => fr.acceptSendJoin(p),
    });
    await joinRemote(app.store, {
      roomId: fr.roomId,
      user: user.user_id,
      via: [fake.name],
      signer: await testSigner('localhost'),
      deps: {
        self: 'localhost',
        keys: fakeKeyResolver(fake, await testRemoteServer('localhost')),
        fetcher: transport.fetcher,
      },
    });
    const before = await sync(user.access_token!);
    const remoteUser = fr.creator;
    await seedServer(app.server, fake);
    const fed = fedCaller(suite.matrix, fake);
    const transaction = await fed(
      'PUT',
      '/_matrix/federation/v1/send/sync-edus',
      {
        origin: fake.name,
        origin_server_ts: Date.now(),
        pdus: [],
        edus: [{
          edu_type: 'm.typing',
          content: { room_id: fr.roomId, user_id: remoteUser, typing: true },
        }, {
          edu_type: 'm.receipt',
          content: {
            [fr.roomId]: {
              'm.read': {
                [remoteUser]: {
                  event_ids: ['$remote-read'],
                  data: { ts: 123, thread_id: '$remote-root' },
                },
              },
            },
          },
        }, {
          edu_type: 'm.receipt',
          content: {
            [fr.roomId]: {
              'm.read': {
                [remoteUser]: {
                  event_ids: ['$remote-main'],
                  data: { ts: 124, thread_id: 'main' },
                },
              },
              'm.read.private': {
                [remoteUser]: {
                  event_ids: ['$remote-private'],
                  data: { ts: 125 },
                },
              },
            },
          },
        }, {
          edu_type: 'm.presence',
          content: {
            push: [{
              user_id: remoteUser,
              presence: 'online',
              status_msg: 'remote',
            }],
          },
        }],
      },
    );
    assertEquals(transaction, { status: 200, body: { pdus: {} } });
    const inbound = await sync(
      user.access_token!,
      '&since=' + before.next_batch + '&filter=' +
        encodeURIComponent('{"room":{"timeline":{"limit":0}}}'),
    );
    assert((eventOf(inbound, fr.roomId, 'm.typing')!.content as Json).user_ids);
    const receiptEv = eventOf(inbound, fr.roomId, 'm.receipt');
    assert(
      receiptEv !== undefined,
      'authenticated HTTP /send receipt reaches rooms.join.ephemeral.events',
    );
    assertEquals(
      (((receiptEv.content as Json)[
        '$remote-read'
      ] as Json)['m.read'] as Json)[remoteUser],
      { ts: 123, thread_id: '$remote-root' },
    );
    const mainReceipt = ephemeral(inbound, fr.roomId).find((e) =>
      e.type === 'm.receipt' &&
      (e.content as Json)['$remote-main'] !== undefined
    );
    assert(mainReceipt !== undefined);
    assertEquals(
      (((mainReceipt.content as Json)['$remote-main'] as Json)[
        'm.read'
      ] as Json)[remoteUser],
      { ts: 124, thread_id: 'main' },
    );
    assert(
      !JSON.stringify(ephemeral(inbound, fr.roomId)).includes(
        '$remote-private',
      ),
    );
    assert(
      ((inbound.presence as Json).events as Json[]).some((e) =>
        e.sender === remoteUser && (e.content as Json).status_msg === 'remote'
      ),
    );
    const base = '/_matrix/client/v3/rooms/' + encodeURIComponent(fr.roomId);
    await call(
      base + '/typing/' + encodeURIComponent(user.user_id),
      user.access_token!,
      'PUT',
      { typing: true },
    );
    await call(
      base + '/receipt/m.read/%24local-read',
      user.access_token!,
      'POST',
      { thread_id: 'main' },
    );
    const localRoot = await call(
      base + '/send/m.room.message/edu-thread-root',
      user.access_token!,
      'PUT',
      {
        msgtype: 'm.text',
        body: 'outbound thread root',
      },
    );
    assertEquals(localRoot.status, 200);
    const rootId = String(localRoot.body.event_id);
    const localReply = await call(
      base + '/send/m.room.message/edu-thread-reply',
      user.access_token!,
      'PUT',
      {
        msgtype: 'm.text',
        body: 'outbound thread reply',
        'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
      },
    );
    assertEquals(localReply.status, 200);
    const replyId = String(localReply.body.event_id);
    assertEquals(
      (await call(
        base + '/receipt/m.read/' + encodeURIComponent(replyId),
        user.access_token!,
        'POST',
        {
          thread_id: rootId,
        },
      )).status,
      200,
    );
    assertEquals(
      (await call(
        base + '/receipt/m.read.private/' + encodeURIComponent(replyId),
        user.access_token!,
        'POST',
        {
          thread_id: rootId,
        },
      )).status,
      200,
    );
    await call(
      base + '/receipt/m.read.private/%24private',
      user.access_token!,
      'POST',
      {},
    );
    await call(
      '/_matrix/client/v3/presence/' + encodeURIComponent(user.user_id) +
        '/status',
      user.access_token!,
      'PUT',
      { presence: 'online' },
    );
    const all = () => received.flatMap((r) => (r.edus ?? []) as Json[]);
    const outboundMarks = () =>
      all().filter((e) => e.edu_type === 'm.receipt').map((e) =>
        ((((e.content as Json)[fr.roomId] as Json)?.['m.read'] as Json)
          ?.[user.user_id]) as Json | undefined
      ).filter((m): m is Json => m !== undefined);
    const deadline = Date.now() + 5000;
    while (
      !['m.typing', 'm.receipt', 'm.presence'].every((t) =>
        all().some((e) => e.edu_type === t)
      ) || !outboundMarks().some((m) =>
        (m.data as Json).thread_id === 'main'
      ) ||
      !outboundMarks().some((m) => (m.data as Json).thread_id === rootId)
    ) {
      assert(Date.now() < deadline, JSON.stringify(received));
      await new Promise((r) => setTimeout(r, 20));
    }
    const wire = JSON.stringify(all());
    assert(!wire.includes('$private'));
    assert(!wire.includes('$remote-read'));
    assert(!wire.includes(remoteUser));
    assert(wire.includes('$local-read'));
    assert(wire.includes('"thread_id":"main"'));
    assert(
      outboundMarks().some((m) =>
        (m.data as Json).thread_id === rootId &&
        (m.event_ids as string[]).includes(replyId)
      ),
      'the TLS counterpart must receive the actual thread-root receipt metadata',
    );
  } finally {
    await unwire();
    await sender.stop();
    await fake.close();
    setConfigForTests({ federation: { cacerts: previousCa } });
    resetCaCertsForTests();
  }
});

suite.test('typing and receipt-only changes wake joined users without waking unrelated users', async () => {
  const a = await suite.registerTestUser('ep-wake-a', 'pw');
  const b = await suite.registerTestUser('ep-wake-b', 'pw');
  const c = await suite.registerTestUser('ep-wake-c', 'pw');
  const { roomId, base } = await roomFor(a, b);
  const sent = await call(
    base + '/send/m.room.message/wake-target',
    a.access_token!,
    'PUT',
    { msgtype: 'm.text', body: 'receipt target' },
  );
  assertEquals(sent.status, 200);
  let before = await sync(b.access_token!);
  const wait = (since: unknown) =>
    call(
      '/_matrix/client/v3/sync?timeout=3000&since=' + since,
      b.access_token!,
    );
  let finished = false;
  const waiting = wait(before.next_batch).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((r) => setTimeout(r, 60));
  const other = await call(
    '/_matrix/client/v3/createRoom',
    c.access_token!,
    'POST',
    {},
  );
  assertEquals(other.status, 200);
  await call(
    '/_matrix/client/v3/rooms/' +
      encodeURIComponent(String(other.body.room_id)) + '/typing/' +
      encodeURIComponent(c.user_id),
    c.access_token!,
    'PUT',
    { typing: true, timeout: 10000 },
  );
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(finished, false);
  const start = performance.now();
  assertEquals(
    (await call(
      base + '/typing/' + encodeURIComponent(a.user_id),
      a.access_token!,
      'PUT',
      { typing: true, timeout: 10000 },
    )).status,
    200,
  );
  const typed = await waiting;
  assertEquals(typed.status, 200);
  assert(performance.now() - start < 450);
  assertEquals(
    (eventOf(typed.body, roomId, 'm.typing')!.content as Json).user_ids,
    [a.user_id],
  );
  await call(
    base + '/typing/' + encodeURIComponent(a.user_id),
    a.access_token!,
    'PUT',
    { typing: false },
  );
  before = await sync(b.access_token!);
  const receiptWait = wait(before.next_batch);
  await new Promise((r) => setTimeout(r, 60));
  const receiptStart = performance.now();
  assertEquals(
    (await call(
      base + '/receipt/m.read/' +
        encodeURIComponent(String(sent.body.event_id)),
      a.access_token!,
      'POST',
      {},
    )).status,
    200,
  );
  const read = await receiptWait;
  assertEquals(read.status, 200);
  assert(performance.now() - receiptStart < 450);
  assert(eventOf(read.body, roomId, 'm.receipt'));
  assertEquals((entry(read.body, roomId).timeline as Json).events, []);
});

suite.test('the keys upload stub retains its old authenticated shape', async () => {
  const user = await suite.registerTestUser('ep-keys', 'pw');
  const missing = await call(
    '/_matrix/client/v3/keys/upload',
    undefined,
    'POST',
    {},
  );
  assertEquals(missing.status, 401);
  assertEquals(missing.body.errcode, 'M_MISSING_TOKEN');
  const upload = await call(
    '/_matrix/client/v3/keys/upload',
    user.access_token!,
    'POST',
    {},
  );
  assertEquals(upload.status, 200);
  assertEquals(upload.body, { one_time_key_counts: {} });
});
