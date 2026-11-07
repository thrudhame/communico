import { assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { deactivateUser } from '#engine/tenant/users.ts';

type Json = Record<string, unknown>;
type Http = Awaited<ReturnType<typeof startHttp>>;
async function call(http: Http, path: string, body?: Json, token?: string) {
  const response = await http.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
function login(http: Http, user: string, device: string, extra: Json = {}) {
  return call(http, 'login', {
    type: 'm.login.password',
    user,
    password: 'pw',
    device_id: device,
    ...extra,
  });
}

Deno.test('review session: another user cannot claim a device through login', async () => {
  const http = await startHttp();
  try {
    await http.registerTestUser('owner', 'pw');
    await http.registerTestUser('other', 'pw');
    const first = await login(http, 'owner', 'owned', {
      initial_device_display_name: 'private label',
    });
    const attempt = await login(http, 'other', 'owned', {
      initial_device_display_name: 'stolen',
    });
    assertEquals(attempt.status, 400);
    assertEquals(attempt.body.errcode, 'M_INVALID_PARAM');
    const token = first.body.access_token as string;
    assertEquals(
      (await call(http, 'account/whoami', undefined, token)).status,
      200,
    );
    assertEquals(
      (await call(http, 'devices/owned', undefined, token)).body.display_name,
      'private label',
    );
  } finally {
    await http.close();
  }
});

Deno.test('review session: only valid credentials disclose deactivation', async () => {
  const http = await startHttp();
  try {
    await http.registerTestUser('inactive', 'pw');
    await deactivateUser(http.app.tenant, 'inactive');
    const wrong = await login(http, 'inactive', 'device', {
      password: 'wrong',
    });
    assertEquals(wrong.status, 403);
    assertEquals(wrong.body.errcode, 'M_FORBIDDEN');
    const valid = await login(http, 'inactive', 'device');
    assertEquals(valid.status, 403);
    assertEquals(valid.body.errcode, 'M_USER_DEACTIVATED');
  } finally {
    await http.close();
  }
});

Deno.test('review session: registration conflict rolls back the new account and preserves device owner', async () => {
  const http = await startHttp();
  try {
    await http.registerTestUser('owner', 'pw');
    const first = await login(http, 'owner', 'owned');
    const input = { username: 'conflict', password: 'pw', device_id: 'owned' };
    const challenge = await call(http, 'register', input);
    const result = await call(http, 'register', {
      ...input,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(result.status, 400);
    assertEquals(result.body.errcode, 'M_INVALID_PARAM');
    assertEquals(
      (await call(http, 'register/available?username=conflict')).status,
      200,
    );
    assertEquals(
      (await call(
        http,
        'devices/owned',
        undefined,
        first.body.access_token as string,
      )).status,
      200,
    );
  } finally {
    await http.close();
  }
});

Deno.test('review session: device relogin atomically replaces tokens, refresh and pushers', async () => {
  const http = await startHttp();
  try {
    await http.registerTestUser('owner', 'pw');
    const first = await login(http, 'owner', 'same', {
      refresh_token: true,
      initial_device_display_name: 'kept',
    });
    const other = await login(http, 'owner', 'other');
    const token = first.body.access_token as string;
    assertEquals(
      (await call(http, 'pushers/set', {
        kind: 'http',
        app_id: 'review',
        pushkey: 'review',
        app_display_name: 'app',
        device_display_name: 'device',
        lang: 'en',
        data: { url: 'https://push.invalid' },
      }, token)).status,
      200,
    );
    const second = await login(http, 'owner', 'same', { refresh_token: true });
    assertEquals(second.status, 200);
    assertEquals(
      (await call(http, 'account/whoami', undefined, token)).status,
      401,
    );
    assertEquals(
      (await call(http, 'refresh', { refresh_token: first.body.refresh_token }))
        .status,
      401,
    );
    const fresh = second.body.access_token as string;
    assertEquals(
      (await call(http, 'account/whoami', undefined, fresh)).body.device_id,
      'same',
    );
    assertEquals(
      (await call(http, 'devices/same', undefined, fresh)).body.display_name,
      'kept',
    );
    assertEquals(
      (await call(http, 'pushers', undefined, fresh)).body.pushers,
      [],
    );
    assertEquals(
      (await call(
        http,
        'account/whoami',
        undefined,
        other.body.access_token as string,
      )).status,
      200,
    );
    assertEquals(
      (await call(http, 'refresh', {
        refresh_token: second.body.refresh_token,
      })).status,
      200,
    );
  } finally {
    await http.close();
  }
});

Deno.test('review session: failed token issuance rolls back device edits and old-session revocation', async () => {
  const http = await startHttp();
  const tx = http.app.tenant.tx;
  try {
    await http.registerTestUser('owner', 'pw');
    const first = await login(http, 'owner', 'same', {
      refresh_token: true,
      initial_device_display_name: 'original',
    });
    http.app.tenant.tx = (fn) =>
      tx(async (bound) => {
        bound.tokens.insert = () =>
          Promise.reject(new Error('injected issuance failure'));
        return await fn(bound);
      });
    const failed = await login(http, 'owner', 'same', {
      initial_device_display_name: 'must roll back',
    });
    http.app.tenant.tx = tx;
    assertEquals(failed.status, 500);
    assertEquals(
      (await call(
        http,
        'devices/same',
        undefined,
        first.body.access_token as string,
      )).body.display_name,
      'original',
    );
    assertEquals(
      (await call(http, 'refresh', { refresh_token: first.body.refresh_token }))
        .status,
      200,
    );
  } finally {
    http.app.tenant.tx = tx;
    await http.close();
  }
});
