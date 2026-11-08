// F5 consumer proofs: a server port is part of the server name, not localpart.
import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';

const self = 'localhost:18450';
setConfigForTests({
  server: { name: self },
  federation: { lookups: 'none' },
});
const { matrix, registerTestUser, test } = httpSuite(
  'HTTP port-bearing identifiers',
);
type Json = Record<string, unknown>;
const enc = encodeURIComponent;
async function call(path: string, token?: string, body?: Json, method = 'GET') {
  const response = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: token === undefined ? {} : { authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function login(user: string, password: string, identifier = true) {
  return await call('login', undefined, {
    type: 'm.login.password',
    password,
    ...(identifier ? { identifier: { type: 'm.id.user', user } } : { user }),
  }, 'POST');
}

test('login accepts full MXID and legacy/bare forms; foreign and malformed ids stay forbidden', async () => {
  const user = await registerTestUser('port-login', 'pw');
  for (const identifier of [true, false]) {
    const result = await login('@PORT-LOGIN:' + self, 'pw', identifier);
    assertEquals(result.status, 200);
    assertEquals(result.body.user_id, user.user_id);
    const who = await call(
      'account/whoami',
      result.body.access_token as string,
    );
    assertEquals(who.body.user_id, user.user_id);
    assertEquals((await login('PORT-LOGIN', 'pw', identifier)).status, 200);
  }
  for (const bad of ['@port-login:other.test:18450', '@port-login']) {
    const result = await login(bad, 'pw');
    assertEquals([result.status, result.body.errcode], [403, 'M_FORBIDDEN']);
  }
  assertEquals((await login(user.user_id, 'wrong')).status, 403);
});

test('UIA full identifier matches caller and updates credentials; mismatches stay 403', async () => {
  const user = await registerTestUser('port-uia', 'pw');
  const token = user.access_token;
  const wrong = await call('account/password', token, {
    new_password: 'must-not-apply',
    auth: {
      type: 'm.login.password',
      password: 'pw',
      identifier: { type: 'm.id.user', user: '@other:' + self },
    },
  }, 'POST');
  assertEquals([wrong.status, wrong.body.errcode], [403, 'M_FORBIDDEN']);
  const result = await call('account/password', token, {
    new_password: 'new-pw',
    logout_devices: false,
    auth: {
      type: 'm.login.password',
      password: 'pw',
      identifier: { type: 'm.id.user', user: user.user_id },
    },
  }, 'POST');
  assertEquals(result.status, 200);
  assertEquals((await login('port-uia', 'pw')).status, 403);
  assertEquals((await login('port-uia', 'new-pw')).status, 200);
});

test('UIA caller fallback and tenant localpartOf persist the account change', async () => {
  const user = await registerTestUser('port-fallback', 'pw');
  const result = await call('account/password', user.access_token, {
    new_password: 'changed',
    logout_devices: false,
    auth: { type: 'm.login.password', password: 'pw' },
  }, 'POST');
  assertEquals(result.status, 200);
  assertEquals((await login('port-fallback', 'pw')).status, 403);
  assertEquals((await login('port-fallback', 'changed')).status, 200);
});

test('profile writes persist through every GET shape and propagate both fields to member state', async () => {
  const user = await registerTestUser('port-profile', 'pw');
  const other = await registerTestUser('port-profile-other', 'pw');
  const token = user.access_token;
  const created = await call(
    'createRoom',
    token,
    { preset: 'public_chat' },
    'POST',
  );
  assertEquals(created.status, 200);
  const room = created.body.room_id as string;
  const profile = 'profile/' + enc(user.user_id);
  const unqualified = enc('@port-profile');
  assertEquals((await call('profile/' + unqualified)).status, 404);
  assertEquals(
    (await call('profile/' + unqualified + '/displayname', token, {
      displayname: 'unqualified must not write',
    }, 'PUT')).status,
    403,
  );
  assertEquals(
    (await call('user/' + unqualified + '/filter', token, {}, 'POST')).status,
    403,
  );
  assertEquals(
    (await call('user/' + unqualified + '/account_data/test', token, {}, 'PUT'))
      .status,
    403,
  );
  assertEquals(
    (await call(profile + '/displayname', other.access_token, {
      displayname: 'unauthorized',
    }, 'PUT')).status,
    403,
  );
  assertEquals(
    (await call(profile + '/displayname', token, { displayname: 42 }, 'PUT'))
      .status,
    400,
  );
  assertEquals(
    (await call(profile + '/displayname', token, {
      displayname: 'Port profile',
    }, 'PUT')).status,
    200,
  );
  assertEquals(
    (await call(profile + '/avatar_url', token, {
      avatar_url: 'mxc://remote/avatar',
    }, 'PUT')).status,
    200,
  );
  const expected = {
    displayname: 'Port profile',
    avatar_url: 'mxc://remote/avatar',
  };
  assertEquals(await call(profile), { status: 200, body: expected });
  assertEquals((await call(profile + '/displayname')).body, {
    displayname: expected.displayname,
  });
  assertEquals((await call(profile + '/avatar_url')).body, {
    avatar_url: expected.avatar_url,
  });
  const member = 'rooms/' + enc(room) + '/state/m.room.member/' +
    enc(user.user_id);
  assertEquals((await call(member, token)).body, {
    membership: 'join',
    ...expected,
  });
  assertEquals(
    (await call(profile + '/displayname', token, { displayname: null }, 'PUT'))
      .status,
    200,
  );
  assertEquals(
    (await call(profile + '/avatar_url', token, { avatar_url: null }, 'PUT'))
      .status,
    200,
  );
  assertEquals((await call(profile)).body, {});
  assertEquals((await call(profile + '/displayname')).body, {});
  assertEquals((await call(profile + '/avatar_url')).body, {});
  assertEquals((await call(member, token)).body, { membership: 'join' });
});

test('local aliases resolve with lookups disabled; alias PUT uses the same server boundary', async () => {
  const user = await registerTestUser('port-alias', 'pw');
  const created = await call('createRoom', user.access_token, {
    preset: 'public_chat',
    room_alias_name: 'port-alias',
  }, 'POST');
  assertEquals(created.status, 200);
  const room = created.body.room_id;
  const expected = { room_id: room, servers: [self] };
  assertEquals(await call('directory/room/' + enc('#port-alias:' + self)), {
    status: 200,
    body: expected,
  });
  const second = '#port-alias-second:' + self;
  assertEquals(
    (await call('directory/room/' + enc(second), user.access_token, {
      room_id: room,
    }, 'PUT')).status,
    200,
  );
  assertEquals((await call('directory/room/' + enc(second))).body, expected);
  const foreign = await call(
    'directory/room/' + enc('#foreign:other.test:18450'),
    user.access_token,
    { room_id: room },
    'PUT',
  );
  assertEquals([foreign.status, foreign.body.errcode], [
    400,
    'M_INVALID_PARAM',
  ]);
  assertEquals(
    (await call('directory/room/' + enc('#missing:other.test:18450'))).status,
    404,
  );
});
