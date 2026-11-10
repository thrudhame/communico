import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP OpenID credential purpose and admission');
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
suite.test('own-user issuance, bearer-only userinfo, purpose separation and revocation', async () => {
  const alice = await suite.registerTestUser('oid-a', 'pw');
  const bob = await suite.registerTestUser('oid-b', 'pw');
  const path = '/_matrix/client/v3/user/' + encodeURIComponent(alice.user_id) +
    '/openid/request_token';
  const minted = await call(path, alice.access_token!, 'POST', {});
  assertEquals(minted.status, 200);
  assertEquals(minted.body.token_type, 'Bearer');
  assertEquals(minted.body.matrix_server_name, 'localhost');
  assertEquals(minted.body.expires_in, 3600);
  const token = String(minted.body.access_token);
  assert(token.length >= 32);
  assert(token !== alice.access_token);
  assertEquals((await call(path, bob.access_token!, 'POST', {})).status, 403);
  assertEquals((await call(path, undefined, 'POST', {})).status, 401);
  assertEquals((await call(path, alice.access_token!, 'POST', [])).status, 400);
  const userinfo = '/_matrix/federation/v1/openid/userinfo';
  assertEquals((await call(userinfo + '?access_token=' + token)).body, {
    sub: alice.user_id,
  });
  assertEquals((await call(userinfo, token)).body, { sub: alice.user_id });
  assertEquals((await call(userinfo)).body.errcode, 'M_MISSING_TOKEN');
  assertEquals(
    (await call(userinfo + '?access_token=invalid')).body.errcode,
    'M_UNKNOWN_TOKEN',
  );
  assertEquals(
    (await call(userinfo + '?access_token=' + alice.access_token)).status,
    401,
  );
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', token)).status,
    401,
  );
  // Adding a bearer credential must not bypass signed federation auth elsewhere.
  assertEquals(
    (await call(
      '/_matrix/federation/v1/query/profile?user_id=' +
        encodeURIComponent(alice.user_id),
      token,
    )).status,
    401,
  );
  const deactivate = '/_matrix/client/v3/account/deactivate';
  const challenge = await call(deactivate, alice.access_token!, 'POST', {});
  assertEquals(challenge.status, 401);
  assertEquals(
    (await call(deactivate, alice.access_token!, 'POST', {
      auth: {
        type: 'm.login.password',
        session: challenge.body.session,
        identifier: { type: 'm.id.user', user: alice.user_id },
        password: 'pw',
      },
    })).status,
    200,
  );
  assertEquals((await call(userinfo + '?access_token=' + token)).status, 401);
});
