import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { captureTyping } from '#engine/typing.ts';

const suite = httpSuite('HTTP account operation contracts');
type Json = Record<string, unknown>;
async function call(
  path: string,
  body?: unknown,
  token?: string,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function register(body: Json) {
  const challenge = await call('register', body);
  assertEquals(challenge.status, 401);
  return await call('register', {
    ...body,
    auth: { type: 'm.login.dummy', session: challenge.body.session },
  });
}

suite.test('omitted username generates a unique usable account localpart', async () => {
  const one = await register({ password: 'pw' }),
    two = await register({ password: 'pw' });
  assertEquals(one.status, 200);
  assertEquals(two.status, 200);
  assert(one.body.user_id !== two.body.user_id);
  assertEquals(
    (await call('account/whoami', undefined, String(one.body.access_token)))
      .body.user_id,
    one.body.user_id,
  );
});
suite.test('inhibited registration creates neither device nor session', async () => {
  const response = await register({
    username: 'operation-inhibited',
    password: 'pw',
    inhibit_login: true,
    device_id: 'NO-DEVICE',
  });
  assertEquals(response.status, 200);
  assertEquals('access_token' in response.body, false);
  assertEquals('device_id' in response.body, false);
  assertEquals(
    await theApp().tenant.tx((tx) => tx.devices.ofUser('operation-inhibited')),
    [],
  );
});
suite.test('guest intent never becomes an ordinary account', async () => {
  const response = await call('register?kind=guest', {
    username: 'operation-not-guest',
    password: 'pw',
  });
  assertEquals([response.status, response.body.errcode], [403, 'M_FORBIDDEN']);
  assertEquals(
    await theApp().tenant.tx((tx) => tx.users.exists('operation-not-guest')),
    false,
  );
  assertEquals(
    (await call('register?kind=other', { password: 'pw' })).status,
    400,
  );
});
suite.test('initial login device name cannot rename an existing device', async () => {
  const user = await register({
    username: 'operation-device',
    password: 'pw',
    device_id: 'KEPT',
    initial_device_display_name: 'Original',
  });
  assertEquals(user.status, 200);
  const login = await call('login', {
    type: 'm.login.password',
    user: 'operation-device',
    password: 'pw',
    device_id: 'KEPT',
    initial_device_display_name: 'Not a rename',
  });
  assertEquals(login.status, 200);
  assertEquals(
    (await call('devices/KEPT', undefined, String(login.body.access_token)))
      .body.display_name,
    'Original',
  );
});

for (
  const [field, value] of [
    ['device_id', 1],
    ['initial_device_display_name', false],
    ['refresh_token', 'true'],
    ['inhibit_login', 1],
  ] as const
) {
  suite.test(
    'registration rejects malformed ' + field + ' before UIA',
    async () => {
      assertEquals(
        (await call('register', { password: 'pw', [field]: value })).status,
        400,
      );
    },
  );
}
for (
  const [field, value] of [['device_id', 1], [
    'initial_device_display_name',
    false,
  ], ['refresh_token', 'true']] as const
) {
  suite.test('login rejects malformed ' + field, async () => {
    await suite.registerTestUser('operation-login-' + field, 'pw');
    assertEquals(
      (await call('login', {
        type: 'm.login.password',
        user: 'operation-login-' + field,
        password: 'pw',
        [field]: value,
      })).status,
      400,
    );
  });
}
for (
  const [field, value] of [
    ['is_direct', 'true'],
    ['visibility', null],
    ['preset', null],
    ['invite', null],
    ['initial_state', null],
  ] as const
) {
  suite.test('createRoom rejects malformed ' + field, async () => {
    const user = await suite.registerTestUser(
      'operation-create-' + field,
      'pw',
    );
    assertEquals(
      (await call('createRoom', { [field]: value }, user.access_token)).status,
      400,
    );
  });
}
suite.test('password logout_devices and presence status_msg retain their types', async () => {
  const user = await suite.registerTestUser('operation-presence', 'pw');
  assertEquals(
    (await call('account/password', {
      new_password: 'new',
      logout_devices: 'false',
    }, user.access_token)).status,
    400,
  );
  assertEquals(
    (await call(
      'presence/' + encodeURIComponent(user.user_id) + '/status',
      { presence: 'online', status_msg: false },
      user.access_token,
      'PUT',
    )).status,
    400,
  );
});
for (
  const body of [{}, { typing: 'true' }, { typing: true, timeout: '1' }, {
    typing: true,
    timeout: 1.5,
  }]
) {
  suite.test(
    'typing rejects malformed operation ' + JSON.stringify(body),
    async () => {
      const user = await suite.registerTestUser(
        'operation-typing-' + crypto.randomUUID().slice(0, 8),
        'pw',
      );
      const room = await call('createRoom', {}, user.access_token);
      assertEquals(room.status, 200);
      const roomId = String(room.body.room_id);
      const path = 'rooms/' + encodeURIComponent(roomId) + '/typing/' +
        encodeURIComponent(user.user_id);
      assertEquals(
        (await call(
          path,
          { typing: true, timeout: 30000 },
          user.access_token,
          'PUT',
        )).status,
        200,
      );
      const before = captureTyping([roomId]);
      assertEquals(
        (await call(path, body, user.access_token, 'PUT')).status,
        400,
      );
      assertEquals(
        captureTyping([roomId]),
        before,
        'malformed intent must not clear typing or advance its stream',
      );
    },
  );
}
