// tests/refresh-token.test.ts — band C item 7 (D8/3h): the
// TestTxnIdWithRefreshToken contract (spec v1.16 refresh.yaml +
// _index.md:567-601). Rotation revokes the old access token; the refresh
// token survives until replacement use. The device is unchanged, so txn idempotency
// keeps working across the refresh (the send half returns with 5a-2).
// expires_in_ms is advertised, never
// enforced. Restored wire assertions, on real loopback HTTP and Turso.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { serverName } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP refresh tokens');

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

test('refresh tokens: issue, rotate, revoke-old, same-device whoami', async () => {
  await registerTestUser('rt-a', 'pw-rt-a');
  const login = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'rt-a' },
      password: 'pw-rt-a',
      refresh_token: true,
    },
  });
  assertEquals(login.status, 200);
  const access1 = login.body.access_token as string;
  const refresh1 = login.body.refresh_token as string;
  const device = login.body.device_id as string;
  assert(typeof refresh1 === 'string');
  assertEquals(login.body.expires_in_ms, 3600000);

  assertEquals(
    (await call('/_matrix/client/v3/pushers/set', {
      method: 'POST',
      token: access1,
      body: {
        app_id: 'refresh-test',
        pushkey: 'key',
        kind: 'http',
        app_display_name: 'test',
        device_display_name: 'test',
        lang: 'en',
        data: { url: 'https://push.invalid/_matrix/push/v1/notify' },
      },
    })).status,
    200,
  );

  // a login WITHOUT the flag carries neither field
  const plain = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'rt-a' },
      password: 'pw-rt-a',
    },
  });
  assertEquals(plain.status, 200);
  assertEquals('refresh_token' in plain.body, false);
  assertEquals('expires_in_ms' in plain.body, false);

  // rotate — the refresh endpoint is public (no Authorization header)
  const rotated = await call('/_matrix/client/v3/refresh', {
    method: 'POST',
    body: { refresh_token: refresh1 },
  });
  assertEquals(rotated.status, 200);
  const access2 = rotated.body.access_token as string;
  const refresh2 = rotated.body.refresh_token as string;
  assertNotEquals(access2, access1);
  assertNotEquals(refresh2, refresh1);
  assertEquals(rotated.body.expires_in_ms, 3600000);

  // The old access is revoked immediately, but an interrupted refresh can retry.
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', {
      token: access1,
    })).status,
    401,
  );
  const retry = await call('/_matrix/client/v3/refresh', {
    method: 'POST',
    body: { refresh_token: refresh1 },
  });
  assertEquals(retry.status, 200);
  assertNotEquals(retry.body.access_token, access2);
  assertNotEquals(retry.body.refresh_token, refresh2);
  // A retry replaces the unused candidate, rather than leaving parallel chains.
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', {
      token: access2,
    })).status,
    401,
  );
  assertEquals(
    (await call('/_matrix/client/v3/refresh', {
      method: 'POST',
      body: { refresh_token: refresh2 },
    })).status,
    401,
  );

  // and the new token really works (whoami shows the same device)
  const who = await call('/_matrix/client/v3/account/whoami', {
    token: retry.body.access_token as string,
  });
  assertEquals(who.status, 200);
  assertEquals(who.body.device_id, device);
  assertEquals(
    who.body.user_id,
    `@rt-a:${serverName()}`,
  );
  const reuse = await call('/_matrix/client/v3/refresh', {
    method: 'POST',
    body: { refresh_token: refresh1 },
  });
  assertEquals(reuse.status, 401);
  assertEquals(reuse.body.errcode, 'M_UNKNOWN_TOKEN');
  const pushers = await call('/_matrix/client/v3/pushers', {
    token: retry.body.access_token as string,
  });
  assertEquals((pushers.body.pushers as Json[]).map((p) => p.app_id), [
    'refresh-test',
  ]);

  // a bogus refresh token → 401 M_UNKNOWN_TOKEN
  const bogus = await call('/_matrix/client/v3/refresh', {
    method: 'POST',
    body: { refresh_token: 'nope' },
  });
  assertEquals(bogus.status, 401);
  assertEquals(bogus.body.errcode, 'M_UNKNOWN_TOKEN');
});

test('using a replacement refresh closes only its predecessor retry window', async () => {
  await registerTestUser('rt-chain', 'pw');
  const login = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      user: 'rt-chain',
      password: 'pw',
      refresh_token: true,
    },
  });
  assertEquals(login.status, 200);
  const rotate = (token: unknown) =>
    call('/_matrix/client/v3/refresh', {
      method: 'POST',
      body: { refresh_token: token },
    });
  const second = await rotate(login.body.refresh_token);
  assertEquals(second.status, 200);
  const third = await rotate(second.body.refresh_token);
  assertEquals(third.status, 200);
  assertEquals((await rotate(login.body.refresh_token)).status, 401);
  // The second token's own retry window is still open until third-pair use.
  const retried = await rotate(second.body.refresh_token);
  assertEquals(retried.status, 200);
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', {
      token: retried.body.access_token as string,
    })).status,
    200,
  );
  assertEquals((await rotate(second.body.refresh_token)).status, 401);
  assertEquals((await rotate(third.body.refresh_token)).status, 401);
  // Logout must revoke the current refresh and any pending predecessor.
  const fourth = await rotate(retried.body.refresh_token);
  assertEquals(fourth.status, 200);
  assertEquals(
    (await call('/_matrix/client/v3/logout', {
      method: 'POST',
      token: fourth.body.access_token as string,
    })).status,
    200,
  );
  assertEquals((await rotate(retried.body.refresh_token)).status, 401);
  assertEquals((await rotate(fourth.body.refresh_token)).status, 401);
});
