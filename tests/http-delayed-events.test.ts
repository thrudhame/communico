import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP delayed events and state-after dialect');
const management = '/_matrix/client/unstable/org.matrix.msc4140/delayed_events';
async function call(
  path: string,
  token?: string,
  method = 'GET',
  body?: unknown,
) {
  const result = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: result.status, body: await result.json() };
}
async function fixture(name: string) {
  const a = await suite.registerTestUser(name, 'pw');
  const token = a.access_token!;
  const r = await call('/_matrix/client/v3/createRoom', token, 'POST', {});
  assertEquals(r.status, 200);
  return { user: a.user_id, token, room: r.body.room_id as string };
}
suite.test('off defaults, truthful capabilities and no immediate-success fallthrough', async () => {
  const a = await fixture('delay-off');
  const path = '/_matrix/client/v3/rooms/' + encodeURIComponent(a.room) +
    '/state/test/own';
  assertEquals(
    (await call(path + '?org.matrix.msc4140.delay=100', a.token, 'PUT', {}))
      .status,
    403,
  );
  assertEquals((await call(path, a.token)).status, 404);
  assertEquals((await call(management)).status, 401);
  assertEquals(
    (await call('/_matrix/client/versions')).body
      .unstable_features['org.matrix.msc4140'],
    false,
  );
  assertEquals(
    (await call('/_matrix/client/v3/capabilities', a.token)).body
      .capabilities['org.matrix.msc4140.delayed_events'],
    { max_delay_ms: 0, max_scheduled: 100 },
  );
});
suite.test('state routes, owned reads, bearer management, restart, cancel, send and limits', async () => {
  setConfigForTests({ delayedevents: { maxdelayms: 60000, maxperuser: 2 } });
  try {
    const a = await fixture('delay-on');
    const b = await fixture('delay-other');
    const base = '/_matrix/client/v3/rooms/' + encodeURIComponent(a.room) +
      '/state/test';
    assertEquals(
      (await call('/_matrix/client/versions')).body
        .unstable_features['org.matrix.msc4140'],
      true,
    );
    for (const raw of ['-1', '1.2', 'NaN', '9007199254740992']) {
      assertEquals(
        (await call(
          base + '?org.matrix.msc4140.delay=' + raw,
          a.token,
          'PUT',
          {},
        )).status,
        400,
      );
    }
    assertEquals(
      (await call(base + '?org.matrix.msc4140.delay=60001', a.token, 'PUT', {}))
        .body.errcode,
      'M_DELAY_TOO_LARGE',
    );
    const first = await call(
      base + '?org.matrix.msc4140.delay=60000',
      a.token,
      'PUT',
      { value: 1 },
    );
    assertEquals(first.status, 200);
    assert(first.body.delay_id);
    assertEquals(first.body.event_id, undefined);
    const id = first.body.delay_id;
    assertEquals((await call(base, a.token)).status, 404);
    assertEquals((await call(management + '/' + id, b.token)).status, 404);
    const own = await call(management + '/' + id, a.token);
    assertEquals(own.body.content, { value: 1 });
    assertEquals(own.body.state_key, '');
    assertEquals(own.body.delay_ms, 60000);
    assertEquals(
      (await call(management + '/' + id, undefined, 'POST', {
        action: 'restart',
      })).status,
      200,
    );
    assertEquals(
      (await call(management + '/' + id + '/nonsense', undefined, 'POST', {}))
        .status,
      400,
    );
    assertEquals(
      (await call(management + '/' + id, undefined, 'POST', {})).body.errcode,
      'M_MISSING_PARAM',
    );
    const second = await call(
      base + '/key?org.matrix.msc4140.delay=60000',
      a.token,
      'PUT',
      { value: 2 },
    );
    assertNotEquals(id, second.body.delay_id);
    assertEquals(
      (await call(
        base + '/third?org.matrix.msc4140.delay=60000',
        a.token,
        'PUT',
        {},
      )).status,
      429,
    );
    const listed = await call(management, a.token);
    assertEquals(listed.body.delayed_events.length, 2);
    assertEquals(listed.body.delayed_events[0].delay, 60000);
    assertEquals(
      (await call(management + '/' + id + '/send', undefined, 'POST', {}))
        .status,
      200,
    );
    assertEquals((await call(base, a.token)).body, { value: 1 });
    assertEquals(
      (await call(management + '/' + id + '/restart', undefined, 'POST', {}))
        .status,
      404,
    );
    assertEquals(
      (await call(management + '/' + second.body.delay_id, undefined, 'POST', {
        action: 'cancel',
      })).status,
      200,
    );
    assertEquals((await call(base + '/key', a.token)).status, 404);
    assertEquals((await call(management, a.token)).body, {
      delayed_events: [],
    });
  } finally {
    setConfigForTests({});
  }
});
suite.test('message transaction retries schedule once and expiry reaches timeline', async () => {
  setConfigForTests({ delayedevents: { maxdelayms: 60000 } });
  try {
    const a = await fixture('delay-message');
    const room = encodeURIComponent(a.room);
    const path = '/_matrix/client/v3/rooms/' + room +
      '/send/m.room.encrypted/txn?org.matrix.msc4140.delay=60000';
    const first = await call(path, a.token, 'PUT', {
      algorithm: 'test',
      ciphertext: 'opaque',
    });
    assertEquals(first.status, 200);
    assertEquals(
      (await call(path, a.token, 'PUT', { different: true })).body,
      first.body,
    );
    assertEquals(
      (await call(management, a.token)).body.delayed_events.length,
      1,
    );
    assertEquals(
      (await call(
        management + '/' + first.body.delay_id + '/send',
        a.token,
        'POST',
        {},
      )).status,
      200,
    );
    const sync = await call('/_matrix/client/v3/sync', a.token);
    assert(
      sync.body.rooms.join[a.room].timeline.events.some((
        e: { content: unknown },
      ) =>
        JSON.stringify(e.content) ===
          JSON.stringify({ algorithm: 'test', ciphertext: 'opaque' })
      ),
    );
    assertEquals((await call(path, a.token, 'PUT', {})).body, first.body);
    assertEquals(
      (await call(management, a.token)).body.delayed_events.length,
      0,
    );
  } finally {
    setConfigForTests({});
  }
});
suite.test('zero delay is a scheduled command and completes without manual send', async () => {
  setConfigForTests({ delayedevents: { maxdelayms: 60000 } });
  try {
    const a = await fixture('delay-zero');
    const path = '/_matrix/client/v3/rooms/' + encodeURIComponent(a.room) +
      '/state/test/zero';
    const first = await call(
      path + '?org.matrix.msc4140.delay=0',
      a.token,
      'PUT',
      { sent: true },
    );
    assertEquals(first.status, 200);
    assert(first.body.delay_id);
    await theApp().delayedEvents.drain();
    const end = Date.now() + 5000;
    let result = await call(path, a.token);
    while (result.status !== 200 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20));
      result = await call(path, a.token);
    }
    assertEquals(result.body, { sent: true });
  } finally {
    setConfigForTests({});
  }
});
suite.test('stable/unstable state-after use one captured cut and matching wire names', async () => {
  const a = await fixture('delay-dialect');
  const path = '/_matrix/client/v3/sync?set_presence=offline&';
  for (
    const [query, key] of [['use_state_after=true', 'state_after'], [
      'org.matrix.msc4222.use_state_after=true',
      'org.matrix.msc4222.state_after',
    ], [
      'use_state_after=true&org.matrix.msc4222.use_state_after=true',
      'state_after',
    ]]
  ) {
    const result = await call(path + query, a.token);
    assertEquals(result.status, 200);
    const room = result.body.rooms.join[a.room];
    assert(room[key]);
    assertEquals(room.state, undefined);
    assertEquals(
      room[
        key === 'state_after' ? 'org.matrix.msc4222.state_after' : 'state_after'
      ],
      undefined,
    );
  }
  const legacy = await call(
    path + 'use_state_after=false&org.matrix.msc4222.use_state_after=true',
    a.token,
  );
  assert(legacy.body.rooms.join[a.room].state);
});
