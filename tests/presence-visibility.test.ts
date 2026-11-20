import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';

const suite = httpSuite('HTTP presence visibility');
type User = Awaited<ReturnType<typeof suite.registerTestUser>>;
type Json = Record<string, unknown>;
const denied = {
  status: 403,
  body: {
    errcode: 'M_FORBIDDEN',
    error: 'You are not allowed to see their presence.',
  },
};

async function call(
  user: User,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: { Authorization: 'Bearer ' + user.access_token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
const presence = (user: User) =>
  '/_matrix/client/v3/presence/' + encodeURIComponent(user.user_id) + '/status';
async function subject(name: string) {
  const user = await suite.registerTestUser(name, 'pw');
  assertEquals(
    (await call(user, presence(user), 'PUT', {
      presence: 'online',
      status_msg: 'private presence status',
    })).status,
    200,
  );
  return user;
}
async function roomFor(a: User, b: User) {
  const created = await call(a, '/_matrix/client/v3/createRoom', 'POST', {
    invite: [b.user_id],
  });
  assertEquals(created.status, 200);
  const base = '/_matrix/client/v3/rooms/' +
    encodeURIComponent(String(created.body.room_id));
  assertEquals((await call(b, base + '/join', 'POST', {})).status, 200);
  return base;
}

suite.test('unrelated user receives the exact Synapse forbidden response', async () => {
  const a = await subject('pv-unrelated-a');
  const b = await suite.registerTestUser('pv-unrelated-b', 'pw');
  assertEquals(await call(b, presence(a)), denied);
});

suite.test('self can read presence and status without any room', async () => {
  const a = await subject('pv-self');
  const result = await call(a, presence(a));
  assertEquals(result.status, 200);
  assertEquals(result.body.presence, 'online');
  assertEquals(result.body.status_msg, 'private presence status');
});

suite.test('joined shared-room member can read presence and status', async () => {
  const a = await subject('pv-shared-a');
  const b = await suite.registerTestUser('pv-shared-b', 'pw');
  await roomFor(a, b);
  const result = await call(b, presence(a));
  assertEquals(result.status, 200);
  assertEquals(result.body.presence, 'online');
  assertEquals(result.body.status_msg, 'private presence status');
});

suite.test('leaving the only shared room revokes GET and sync presence', async () => {
  const a = await subject('pv-left-a');
  const b = await suite.registerTestUser('pv-left-b', 'pw');
  const base = await roomFor(a, b);
  const before = await call(b, '/_matrix/client/v3/sync?timeout=0');
  assertEquals(before.status, 200);
  const events = (body: Json) =>
    (body.presence as { events: Json[] }).events.filter((e) =>
      e.sender === a.user_id
    );
  assertEquals(events(before.body).length, 1);
  assertEquals((await call(b, base + '/leave', 'POST', {})).status, 200);
  assertEquals(await call(b, presence(a)), denied);
  for (const query of ['', '&since=' + before.body.next_batch]) {
    const after = await call(b, '/_matrix/client/v3/sync?timeout=0' + query);
    assertEquals(after.status, 200);
    assertEquals(events(after.body), []);
  }
});

suite.test('invitation alone does not disclose presence', async () => {
  const a = await subject('pv-invite-a');
  const b = await suite.registerTestUser('pv-invite-b', 'pw');
  assertEquals(
    (await call(a, '/_matrix/client/v3/createRoom', 'POST', {
      invite: [b.user_id],
    })).status,
    200,
  );
  assertEquals(await call(b, presence(a)), denied);
});

suite.test('incomplete replica membership returns unavailable before disclosure or false denial', async () => {
  const a = await subject('pv-readiness-a');
  const b = await suite.registerTestUser('pv-readiness-b', 'pw');
  const outsider = await suite.registerTestUser('pv-readiness-c', 'pw');
  await roomFor(a, b);
  const app = theApp();
  const previous = Object.getOwnPropertyDescriptor(app, 'replica');
  const unavailable = () => {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
  };
  try {
    for (const phase of ['inventory', 'successor']) {
      const scopes: string[] = [];
      let checks = 0;
      Object.defineProperty(app, 'replica', {
        configurable: true,
        value: {
          requireScope(scope: string) {
            scopes.push(scope);
            if (phase === 'inventory') unavailable();
            return Promise.resolve();
          },
          prepareRoomScope() {
            return Promise.resolve({
              check() {
                checks++;
                unavailable();
              },
            });
          },
        },
      });
      for (const observer of phase === 'successor' ? [b] : [b, outsider]) {
        assertEquals(await call(observer, presence(a)), {
          status: 503,
          body: { errcode: 'M_UNAVAILABLE', error: 'replica unavailable' },
        });
      }
      assertEquals(scopes.every((scope) => scope === 'rooms'), true);
      assertEquals(checks, phase === 'successor' ? 1 : 0);
      assertEquals((await call(a, presence(a))).status, 200);
    }
  } finally {
    if (previous) Object.defineProperty(app, 'replica', previous);
    else Reflect.deleteProperty(app, 'replica');
  }
});
