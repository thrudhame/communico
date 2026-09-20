// tests/refresh-token.test.ts — band C item 7 (D8/3h): the
// TestTxnIdWithRefreshToken contract (spec v1.16 refresh.yaml +
// _index.md:567-601). Rotation revokes the old access token and consumes
// the old refresh token; the device is unchanged, so txn idempotency
// keeps working across the refresh. expires_in_ms is advertised, never
// enforced (say-so in code at tenant.ts). Live doltgres, HTTP-level via
// the real endpoint trees.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

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

Deno.test('refresh tokens: issue, rotate, revoke-old, same-device txn idempotency', async () => {
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

  // send an event with a txn id on the ORIGINAL token
  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: access1,
    body: {},
  })).body.room_id as string;
  const send = (tok: string) =>
    call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/rt-txn`,
      { method: 'PUT', token: tok, body: { msgtype: 'm.text', body: 'hi' } },
    );
  const first = (await send(access1)).body.event_id as string;

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

  // the OLD access token is revoked; the OLD refresh token is consumed
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', {
      token: access1,
    })).status,
    401,
  );
  const reuse = await call('/_matrix/client/v3/refresh', {
    method: 'POST',
    body: { refresh_token: refresh1 },
  });
  assertEquals(reuse.status, 401);
  assertEquals(reuse.body.errcode, 'M_UNKNOWN_TOKEN');

  // txn idempotency is device-scoped — the refresh kept the device, so a
  // repeat of the txn on the NEW token returns the SAME event id
  const again = (await send(access2)).body.event_id as string;
  assertEquals(again, first);

  // and the new token really works (whoami shows the same device)
  const who = await call('/_matrix/client/v3/account/whoami', {
    token: access2,
  });
  assertEquals(who.status, 200);
  assertEquals(who.body.device_id, device);
  assertEquals(
    who.body.user_id,
    `@rt-a:${serverName()}`,
  );

  // a bogus refresh token → 401 M_UNKNOWN_TOKEN
  const bogus = await call('/_matrix/client/v3/refresh', {
    method: 'POST',
    body: { refresh_token: 'nope' },
  });
  assertEquals(bogus.status, 401);
  assertEquals(bogus.body.errcode, 'M_UNKNOWN_TOKEN');
});
