import { assert, assertEquals, assertRejects } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { roomEvents } from '#engine/client/peeking.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP room peeking');
async function call(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function ok(
  path: string,
  token?: string,
  body?: unknown,
  method?: string,
) {
  const r = await call(path, token, body, method);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const base = (room: string) => 'rooms/' + encodeURIComponent(room);
const events = (room: string, from: string, timeout = 0) =>
  'events?room_id=' + encodeURIComponent(room) + '&from=' +
  encodeURIComponent(from) + '&timeout=' + timeout;
const chunk = (r: Json) => (r.chunk as Json[]).map((e) => e.event_id);
async function fixture(prefix: string) {
  const a = await suite.registerTestUser(prefix + '-a', 'pw');
  const b = await suite.registerTestUser(prefix + '-b', 'pw');
  const room = String(
    (await ok('createRoom', a.access_token!, {
      name: 'Before',
      initial_state: [{
        type: 'm.room.history_visibility',
        content: { history_visibility: 'world_readable' },
      }],
    })).room_id,
  );
  const send = async (name: string) =>
    String(
      (await ok(base(room) + '/send/m.room.message/' + name, a.access_token!, {
        msgtype: 'm.text',
        body: name,
      }, 'PUT')).event_id,
    );
  return { a, b, room, send };
}

suite.test('initialSync previews held world-readable rooms without joining and exposes only caller account data', async () => {
  const f = await fixture('peek-initial');
  const one = await f.send('one'), two = await f.send('two');
  for (
    const [user, token, value] of [[f.a.user_id, f.a.access_token!, 'owner'], [
      f.b.user_id,
      f.b.access_token!,
      'reader',
    ]]
  ) {
    await ok(
      'user/' + encodeURIComponent(user) + '/rooms/' +
        encodeURIComponent(f.room) + '/account_data/org.example',
      token,
      { value },
      'PUT',
    );
  }
  const before = await theApp().server.query(
    'SELECT * FROM memberships WHERE room=?',
    [f.room],
  );
  const result = await ok(
    base(f.room) + '/initialSync?limit=2',
    f.b.access_token!,
  );
  assertEquals(result.room_id, f.room);
  assertEquals(result.membership, 'leave');
  assertEquals(chunk(result.messages as Json), [one, two]);
  assertEquals(result.account_data, [{
    type: 'org.example',
    content: { value: 'reader' },
  }]);
  assertEquals(
    (result.state as Json[]).some((e) => e.type === 'm.room.create'),
    true,
  );
  assertEquals(
    await theApp().server.query('SELECT * FROM memberships WHERE room=?', [
      f.room,
    ]),
    before,
  );
  assertEquals((await call(base(f.room) + '/initialSync')).status, 401);
  const privateRoom = String(
    (await ok('createRoom', f.a.access_token!, {})).room_id,
  );
  assertEquals(
    (await call(base(privateRoom) + '/initialSync', f.b.access_token!)).status,
    403,
  );
  assertEquals(
    (await call(
      'events?room_id=' + encodeURIComponent(privateRoom),
      f.b.access_token!,
    )).status,
    403,
  );
  assertEquals(
    (await call(base(f.room) + '/initialSync?limit=no', f.b.access_token!))
      .status,
    400,
  );
  const initial = result.messages as Json;
  const page = await ok(
    base(f.room) + '/messages?dir=b&from=' + initial.start + '&limit=1',
    f.a.access_token!,
  );
  assertEquals((page.chunk as Json[]).length, 1);
  const next = await f.send('next');
  assertEquals(
    chunk(await ok(events(f.room, String(initial.end)), f.b.access_token!)),
    [next],
  );
});

suite.test('declining an invitation is not a departure granting private room state', async () => {
  const a = await suite.registerTestUser('peek-invite-a', 'pw');
  const b = await suite.registerTestUser('peek-invite-b', 'pw');
  const room = String(
    (await ok('createRoom', a.access_token!, { invite: [b.user_id] })).room_id,
  );
  await ok(base(room) + '/leave', b.access_token!, {});
  assertEquals(
    (await call(base(room) + '/initialSync', b.access_token!)).status,
    403,
  );
  assertEquals(
    (await call('events?room_id=' + encodeURIComponent(room), b.access_token!))
      .status,
    403,
  );
});

suite.test('bounded event pages do not skip and an armed poll cancels cleanly', async () => {
  const f = await fixture('peek-bounded');
  const initial = await ok(
    base(f.room) + '/initialSync?limit=0',
    f.b.access_token!,
  );
  let token = String((initial.messages as Json).end);
  const ids = [await f.send('one'), await f.send('two'), await f.send('three')];
  try {
    setConfigForTests({ peeking: { maxevents: 1 } });
    for (const id of ids) {
      const page = await ok(events(f.room, token), f.b.access_token!);
      assertEquals(chunk(page), [id]);
      token = String(page.end);
    }
    const controller = new AbortController();
    const pending = roomEvents(
      f.room,
      f.b.user_id,
      null,
      token,
      2000,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await assertRejects(() => pending, DOMException, 'aborted');
    assertEquals(
      chunk(await ok(events(f.room, token, 10), f.b.access_token!)),
      [],
    );
  } finally {
    setConfigForTests({});
  }
});

suite.test('peeking retains departure messages and state and refuses banned or forgotten readers', async () => {
  const f = await fixture('peek-departure');
  await ok(base(f.room) + '/invite', f.a.access_token!, {
    user_id: f.b.user_id,
  });
  await ok(base(f.room) + '/join', f.b.access_token!, {});
  const before = await f.send('before-leave');
  await ok(base(f.room) + '/leave', f.b.access_token!, {});
  const left = await ok(base(f.room) + '/initialSync', f.b.access_token!);
  await ok(base(f.room) + '/state/m.room.name', f.a.access_token!, {
    name: 'After',
  }, 'PUT');
  const after = await f.send('after-leave');
  const result = await ok(base(f.room) + '/initialSync', f.b.access_token!);
  assertEquals(result.membership, 'leave');
  assert(chunk(result.messages as Json).includes(before));
  assertEquals(chunk(result.messages as Json).includes(after), false);
  assertEquals(
    ((result.state as Json[]).find((e) => e.type === 'm.room.name')!
      .content as Json).name,
    'Before',
  );
  assertEquals(
    chunk(
      await ok(
        events(f.room, String((left.messages as Json).end)),
        f.b.access_token!,
      ),
    ),
    [],
  );
  await ok(base(f.room) + '/forget', f.b.access_token!, {});
  assertEquals(
    (await call(base(f.room) + '/initialSync', f.b.access_token!)).status,
    403,
  );
  await ok(base(f.room) + '/ban', f.a.access_token!, { user_id: f.b.user_id });
  assertEquals(
    (await call(
      'events?room_id=' + encodeURIComponent(f.room),
      f.b.access_token!,
    )).status,
    403,
  );
});

suite.test('room events resume, long-poll without lost wakeups, recheck access and respect timeout/cancellation', async () => {
  const f = await fixture('peek-poll');
  const initial = await ok(
    base(f.room) + '/initialSync?limit=0',
    f.b.access_token!,
  );
  let token = String((initial.messages as Json).end);
  for (let i = 0; i < 3; i++) {
    const poll = ok(events(f.room, token, 2000), f.b.access_token!);
    const id = await f.send('wake-' + i);
    const result = await poll;
    assert(chunk(result).includes(id));
    token = String(result.end);
  }
  const timed = await ok(events(f.room, token, 10), f.b.access_token!);
  assertEquals(chunk(timed), []);
  assertEquals(
    (await call(events(f.room, 'invalid'), f.b.access_token!)).status,
    400,
  );
  assertEquals((await call('events', f.b.access_token!)).status, 400);
  assertEquals(
    (await call(events(f.room, token, -1), f.b.access_token!)).status,
    400,
  );
  const controller = new AbortController();
  const cancelled = call(
    events(f.room, token, 2000),
    f.b.access_token!,
    undefined,
    'GET',
    controller.signal,
  );
  controller.abort();
  await assertRejects(() => cancelled, DOMException);
  const pending = call(events(f.room, token, 2000), f.b.access_token!);
  await ok(
    base(f.room) + '/state/m.room.history_visibility',
    f.a.access_token!,
    { history_visibility: 'joined' },
    'PUT',
  );
  assertEquals((await pending).status, 403);
});
