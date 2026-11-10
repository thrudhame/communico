import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP extended profile fields');
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
suite.test('one public profile supports arbitrary JSON, explicit delete and legacy fields without membership leakage', async () => {
  const alice = await suite.registerTestUser('pf-a', 'pw');
  const bob = await suite.registerTestUser('pf-b', 'pw');
  const token = alice.access_token!;
  const profile = '/_matrix/client/v3/profile/' +
    encodeURIComponent(alice.user_id);
  const capabilities = await call('/_matrix/client/v3/capabilities', token);
  assertEquals((capabilities.body.capabilities as Json)['m.profile_fields'], {
    enabled: true,
  });
  const values = [null, false, 42, 'text', ['nested', 3], {
    nested: { value: true },
  }];
  for (const value of values) {
    assertEquals(
      (await call(profile + '/org.example.value', token, 'PUT', {
        'org.example.value': value,
      })).status,
      200,
    );
    assertEquals((await call(profile + '/org.example.value')).body, {
      'org.example.value': value,
    });
    assertEquals((await call(profile)).body['org.example.value'], value);
  }
  assertEquals(
    (await call(profile + '/org.example.value', bob.access_token!, 'PUT', {
      'org.example.value': 2,
    })).status,
    403,
  );
  assertEquals(
    (await call(profile + '/org.example.value', undefined, 'PUT', {
      'org.example.value': 2,
    })).status,
    401,
  );
  assertEquals(
    (await call(profile + '/org.example.value', token, 'PUT', {})).body.errcode,
    'M_MISSING_PARAM',
  );
  assertEquals(
    (await call(profile + '/m.tz', token, 'PUT', {
      'm.tz': 'America/Los_Angeles',
    })).status,
    200,
  );
  assertEquals((await call(profile + '/m.tz')).body, {
    'm.tz': 'America/Los_Angeles',
  });
  assertEquals(
    (await call(profile + '/org.example.value', bob.access_token!, 'DELETE'))
      .status,
    403,
  );
  assertEquals(
    (await call(profile + '/org.example.value', token, 'DELETE')).status,
    200,
  );
  assertEquals((await call(profile + '/org.example.value')).status, 404);
  assertEquals(
    (await call(profile + '/org.example.value', token, 'DELETE')).status,
    200,
  );
  for (const key of ['invalid', 'Bad.key', 'org..key', '__proto__']) {
    assertEquals(
      (await call(profile + '/' + key, token, 'PUT', { [key]: 1 })).status,
      400,
    );
  }
  const longKey = 'org.' + 'a'.repeat(252);
  assertEquals(
    (await call(profile + '/' + longKey, token, 'PUT', { [longKey]: true }))
      .body.errcode,
    'M_KEY_TOO_LARGE',
  );
  const validKey = 'org.' + 'a'.repeat(251);
  assertEquals(
    (await call(profile + '/' + validKey, token, 'PUT', { [validKey]: null }))
      .status,
    200,
  );
  assertEquals(
    (await call(profile + '/org.example.big', token, 'PUT', {
      'org.example.big': 'x'.repeat(65536),
    })).body.errcode,
    'M_PROFILE_TOO_LARGE',
  );
  assertEquals((await call(profile + '/org.example.big')).status, 404);
  assertEquals(
    (await call(profile + '/displayname', token, 'PUT', {
      displayname: 'Visible Alice',
    })).status,
    200,
  );
  const created = await call('/_matrix/client/v3/createRoom', token, 'POST', {
    preset: 'public_chat',
  });
  const room = String(created.body.room_id);
  const members = await call(
    '/_matrix/client/v3/rooms/' + encodeURIComponent(room) + '/joined_members',
    token,
  );
  const member = (members.body.joined as Json)[alice.user_id] as Json;
  assertEquals(member.display_name, 'Visible Alice');
  assertEquals(member['m.tz'], undefined);
  assertEquals(member[validKey], undefined);
  const state = await call(
    '/_matrix/client/v3/rooms/' + encodeURIComponent(room) +
      '/state/m.room.member/' + encodeURIComponent(alice.user_id),
    token,
  );
  assertEquals(state.body.displayname, 'Visible Alice');
  assertEquals(state.body['m.tz'], undefined);
  assertEquals(state.body[validKey], undefined);
  assertEquals(
    (await call(profile + '/displayname', token, 'DELETE')).status,
    200,
  );
  assertEquals((await call(profile)).body.displayname, undefined);
  const after = await call(profile);
  assert(Object.hasOwn(after.body, validKey));
});

suite.test('avatar and timezone strings remain opaque while non-strings are rejected', async () => {
  const alice = await suite.registerTestUser('pf-opaque', 'pw');
  const token = alice.access_token!;
  const profile = '/_matrix/client/v3/profile/' +
    encodeURIComponent(alice.user_id);
  const made = await call('/_matrix/client/v3/createRoom', token, 'POST', {});
  assertEquals(made.status, 200);
  const membership = '/_matrix/client/v3/rooms/' +
    encodeURIComponent(String(made.body.room_id)) + '/state/m.room.member/' +
    encodeURIComponent(alice.user_id);
  for (
    const avatar of [
      'LemurLover',
      '',
      'https://example.test/avatar',
      'mxc://remote/avatar',
    ]
  ) {
    assertEquals(
      (await call(profile + '/avatar_url', token, 'PUT', {
        avatar_url: avatar,
      })).status,
      200,
    );
    assertEquals((await call(profile + '/avatar_url')).body.avatar_url, avatar);
    assertEquals((await call(membership, token)).body.avatar_url, avatar);
  }
  for (const zone of ['Unknown/NotAnIANAZone', '', 'America/Los_Angeles']) {
    assertEquals(
      (await call(profile + '/m.tz', token, 'PUT', { 'm.tz': zone })).status,
      200,
    );
    assertEquals((await call(profile + '/m.tz')).body['m.tz'], zone);
    assertEquals((await call(membership, token)).body['m.tz'], undefined);
  }
  for (const key of ['avatar_url', 'm.tz']) {
    for (const value of [null, 42, false, [], {}]) {
      const rejected = await call(profile + '/' + key, token, 'PUT', {
        [key]: value,
      });
      assertEquals(rejected.status, 400);
      assertEquals(rejected.body.errcode, 'M_INVALID_PARAM');
    }
  }
});
