import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP older wire aliases');
async function call(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
const paths = (id: string) => [
  'v1/room_summary/' + encodeURIComponent(id),
  'unstable/im.nheko.summary/rooms/' + encodeURIComponent(id) + '/summary',
  'unstable/im.nheko.summary/summary/' + encodeURIComponent(id),
];

suite.test('both historical summary paths share stable metadata, optional auth and visibility', async () => {
  const a = await suite.registerTestUser('wire-owner', 'pw');
  const b = await suite.registerTestUser('wire-outsider', 'pw');
  const create = async (body: Json) => {
    const response = await call('v3/createRoom', a.access_token!, body);
    assertEquals(response.status, 200);
    return String(response.body.room_id);
  };
  const publicRoom = await create({
    preset: 'public_chat',
    name: 'Legacy preview',
    room_alias_name: 'wire-preview',
    creation_content: { type: 'm.space' },
  });
  const privateRoom = await create({ name: 'Private preview' });
  const compare = async (
    id: string,
    token: string | undefined,
    expected: number,
    suffix = '',
  ) => {
    const variants = paths(id);
    const stable = await call(variants[0] + suffix, token);
    assertEquals(stable.status, expected);
    for (const path of variants.slice(1)) {
      const legacy = await call(path + suffix, token);
      assertEquals(legacy.status, stable.status);
      if (expected === 200) assertEquals(legacy.body, stable.body);
      else assertEquals(legacy.body.errcode, stable.body.errcode);
    }
  };
  await compare(publicRoom, undefined, 200);
  await compare(
    publicRoom,
    b.access_token!,
    200,
    '?via=elsewhere.invalid&via=localhost',
  );
  await compare('#wire-preview:' + a.home_server, b.access_token!, 200);
  await compare(privateRoom, a.access_token!, 200);
  await compare(privateRoom, undefined, 404);
  await compare(privateRoom, b.access_token!, 404);
  await compare(publicRoom, 'invalid-token', 401);
  await compare('!missing:localhost', undefined, 404);
  await compare('invalid', undefined, 400);
  const invite = await call(
    'v3/rooms/' + encodeURIComponent(privateRoom) + '/invite',
    a.access_token!,
    { user_id: b.user_id },
  );
  assertEquals(invite.status, 200);
  await compare(privateRoom, b.access_token!, 200);
});

suite.test('stable profile compatibility flag corresponds to actual custom-field lifecycle', async () => {
  const versions = await suite.matrix(
    new Request('http://x/_matrix/client/versions'),
  );
  const body = await versions.json();
  assertEquals(body.unstable_features['uk.tcpip.msc4133.stable'], true);
  const a = await suite.registerTestUser('wire-profile', 'pw');
  const profile = 'v3/profile/' + encodeURIComponent(a.user_id!);
  const path = profile + '/org.example.timezone';
  assertEquals(
    (await call(path, a.access_token!, {
      'org.example.timezone': 'America/Los_Angeles',
    }, 'PUT')).status,
    200,
  );
  assertEquals((await call(path)).body, {
    'org.example.timezone': 'America/Los_Angeles',
  });
  assertEquals(
    (await call(path, a.access_token!, undefined, 'DELETE')).status,
    200,
  );
  assertEquals('org.example.timezone' in (await call(profile)).body, false);
});
