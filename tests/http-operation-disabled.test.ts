import { assert, assertEquals } from '@std/assert';
import { manifest } from '#tests/spec-contract.ts';
import { theApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';

const suite = httpSuite('HTTP explicitly disabled operation contracts');
type Json = Record<string, unknown>;
async function call(method: string, path: string, token: string, body?: Json) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: { authorization: 'Bearer ' + token },
      body: ['GET', 'HEAD'].includes(method)
        ? undefined
        : JSON.stringify(body ?? {}),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

suite.test('excluded operations never manufacture successful actions', async () => {
  const user = await suite.registerTestUser('excluded-operation-user', 'pw');
  const endpoints = JSON.parse(
    await Deno.readTextFile(
      new URL('fixtures/versions-endpoints.json', import.meta.url),
    ),
  ) as { file: string; method: string; path: string; status: string }[];
  const peer = await remoteServer();
  const fed = fedCaller(suite.matrix, peer);
  for (const operation of endpoints.filter((e) => e.status !== 'Routed')) {
    assert(
      manifest.operations.some((o) =>
        o.id === operation.file + '#' + operation.method + ' ' + operation.path
      ),
    );
    const path = operation.path.replaceAll(/\{[^}]+\}/g, 'unavailable');
    const result = operation.file.includes('/server-server/')
      ? await fed(operation.method, path, {})
      : await call(operation.method, path, user.access_token!);
    assert(
      result.status >= 400 && result.status < 500,
      operation.method + ' ' + path + ': ' + JSON.stringify(result),
    );
    assertEquals(typeof result.body.errcode, 'string');
  }
});

suite.test('disabled conditional producers never publish successful writes', async () => {
  const user = await suite.registerTestUser('disabled-producer-user', 'pw');
  const before = await theApp().server.query('SELECT * FROM rooms');
  const made = await call(
    'POST',
    '/_matrix/client/v3/createRoom',
    user.access_token!,
    {
      invite_3pid: [{
        id_server: 'identity.test',
        id_access_token: 'secret',
        medium: 'email',
        address: 'a@example.test',
      }],
    },
  );
  assertEquals(made.status, 400);
  assertEquals(made.body.errcode, 'M_UNRECOGNIZED');
  assertEquals(await theApp().server.query('SELECT * FROM rooms'), before);
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: true,
      allowunencryptedjoining: true,
    },
  });
  try {
    const normal = await call(
      'POST',
      '/_matrix/client/v3/createRoom',
      user.access_token!,
      { preset: 'public_chat', invite_3pid: [] },
    );
    assertEquals(normal.status, 200);
    for (
      const path of [
        '/rooms/' + encodeURIComponent(String(normal.body.room_id)) + '/join',
        '/join/' + encodeURIComponent(String(normal.body.room_id)),
      ]
    ) {
      const joined = await call(
        'POST',
        '/_matrix/client/v3' + path,
        user.access_token!,
        {
          third_party_signed: {
            sender: '@sender:identity.test',
            mxid: user.user_id,
            token: 'token',
            signatures: {},
          },
        },
      );
      assertEquals([joined.status, joined.body.errcode], [
        400,
        'M_UNRECOGNIZED',
      ]);
    }
  } finally {
    setConfigForTests({});
  }
});
