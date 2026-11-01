// Restored doltgres:tests/account.test.ts wire assertions, on a fresh
// Turso app and real loopback HTTP. A8 lives in http-contract.test.ts.
import { assert, assertEquals } from '@std/assert';
import { serverName } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP account endpoints');
const SN = serverName();

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
  let parsed: Json = {};
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      parsed = { _raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function loginBody(
  localpart: string,
  password: string,
  extra: Json = {},
): Json {
  return {
    identifier: { type: 'm.id.user', user: `@${localpart}:${SN}` },
    type: 'm.login.password',
    password,
    ...extra,
  };
}

function pwAuth(localpart: string, password: string, session?: string): Json {
  const auth: Json = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: `@${localpart}:${SN}` },
    password,
  };
  if (session !== undefined) auth.session = session;
  return auth;
}

test('register: dummy auth WITHOUT a session → 401 (session required); with the session → 200', async () => {
  // Wire pin for the Complement TestRegistration regression caught by the
  // M2 baseline run: register's UIA session is required, never one-shot
  // ("Registration without a session fails" — apidoc_register_test.go:299).
  const r1 = await call('/_matrix/client/v3/register', {
    method: 'POST',
    body: {
      username: 'nosess',
      password: 'pw-nosess',
      auth: { type: 'm.login.dummy' },
    },
  });
  assertEquals(r1.status, 401);
  assertEquals(typeof r1.body.session, 'string');
  const r2 = await call('/_matrix/client/v3/register', {
    method: 'POST',
    body: {
      username: 'nosess',
      password: 'pw-nosess',
      auth: { type: 'm.login.dummy', session: r1.body.session },
    },
  });
  assertEquals(r2.status, 200);
  assertEquals(r2.body.user_id, `@nosess:${SN}`);
});

test('A1: login honors device_id + display name; GET/list/PUT; unknown → 404', async () => {
  const alice = await registerTestUser('a1alice', 'pw-a1alice');
  const login = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a1alice', 'pw-a1alice', {
      device_id: 'login_device',
      initial_device_display_name: 'device display',
    }),
  });
  assertEquals(login.status, 200);
  assertEquals(login.body.device_id, 'login_device');
  const tok = alice.access_token;
  const one = await call('/_matrix/client/v3/devices/login_device', {
    token: tok,
  });
  assertEquals(one.status, 200);
  assertEquals(one.body, {
    device_id: 'login_device',
    display_name: 'device display',
  });
  assertEquals(
    (await call('/_matrix/client/v3/devices/unknown_device', { token: tok }))
      .status,
    404,
  );
  const list = await call('/_matrix/client/v3/devices', { token: tok });
  assertEquals(list.status, 200);
  const ids = (list.body.devices as Json[]).map((d) => d.device_id);
  assert(ids.includes('login_device'), `devices[] lacks login_device: ${ids}`);
  assert(
    ids.includes(alice.device_id),
    `devices[] lacks the register device: ${ids}`,
  );
  const put = await call('/_matrix/client/v3/devices/login_device', {
    method: 'PUT',
    token: tok,
    body: { display_name: 'new device display' },
  });
  assertEquals(put.status, 200);
  const after = await call('/_matrix/client/v3/devices/login_device', {
    token: tok,
  });
  assertEquals(after.body.display_name, 'new device display');
  assertEquals(
    (await call('/_matrix/client/v3/devices/unknown_device', {
      method: 'PUT',
      token: tok,
      body: { display_name: 'x' },
    })).status,
    404,
  );
});

test('A1: DELETE device — bodyless 401 (session/flows/params), wrong pw 401 M_FORBIDDEN, right pw 200, token dead', async () => {
  const alice = await registerTestUser('a1del', 'pw-a1del');
  const tok = alice.access_token;
  const l2 = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a1del', 'pw-a1del', { device_id: 'd2' }),
  });
  assertEquals(l2.status, 200);
  const d2tok = l2.body.access_token as string;
  // No body at all → the UIA 401 with session, flows, params.
  const r1 = await call('/_matrix/client/v3/devices/d2', {
    method: 'DELETE',
    token: tok,
  });
  assertEquals(r1.status, 401);
  assertEquals(typeof r1.body.session, 'string');
  assert(Array.isArray(r1.body.flows));
  assert('params' in r1.body);
  // Wrong password, no session → 401 M_FORBIDDEN carrying the UIA keys.
  const r2 = await call('/_matrix/client/v3/devices/d2', {
    method: 'DELETE',
    token: tok,
    body: { auth: pwAuth('a1del', 'WRONG') },
  });
  assertEquals(r2.status, 401);
  assertEquals(r2.body.errcode, 'M_FORBIDDEN');
  assertEquals(typeof r2.body.error, 'string');
  assert(Array.isArray(r2.body.flows));
  assert('params' in r2.body);
  assertEquals(typeof r2.body.session, 'string');
  // Right password with the session → 200; device gone; d2's token dead.
  const r3 = await call('/_matrix/client/v3/devices/d2', {
    method: 'DELETE',
    token: tok,
    body: { auth: pwAuth('a1del', 'pw-a1del', r2.body.session as string) },
  });
  assertEquals(r3.status, 200);
  assertEquals(
    (await call('/_matrix/client/v3/devices/d2', { token: tok })).status,
    404,
  );
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', { token: d2tok })).status,
    401,
  );
});

test("A1: DELETE with another user's creds → 403 (device survives); own creds → 200 → 404", async () => {
  const alice = await registerTestUser('a1xalice', 'pw-xa');
  await registerTestUser('a1xbob', 'pw-xb');
  const l = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a1xalice', 'pw-xa', { device_id: 'd3' }),
  });
  assertEquals(l.status, 200);
  // Bob's VALID creds in auth, alice's token → 403 before any password
  // verification (identifier ≠ caller).
  const r = await call('/_matrix/client/v3/devices/d3', {
    method: 'DELETE',
    token: alice.access_token,
    body: { auth: pwAuth('a1xbob', 'pw-xb') },
  });
  assertEquals(r.status, 403);
  assertEquals(r.body.errcode, 'M_FORBIDDEN');
  assertEquals(
    (await call('/_matrix/client/v3/devices/d3', { token: alice.access_token }))
      .status,
    200,
  );
  const ok = await call('/_matrix/client/v3/devices/d3', {
    method: 'DELETE',
    token: alice.access_token,
    body: { auth: pwAuth('a1xalice', 'pw-xa') },
  });
  assertEquals(ok.status, 200);
  assertEquals(
    (await call('/_matrix/client/v3/devices/d3', { token: alice.access_token }))
      .status,
    404,
  );
});

test('A4: change password — one-shot UIA, old pw dies, caller token kept, logout_devices default/false', async () => {
  const u = await registerTestUser('a4user', 'pw-a4-old');
  const second = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-old'),
  });
  assertEquals(second.status, 200);
  const secondTok = second.body.access_token as string;
  // One-shot change — no prior session (Complement's changePassword).
  const ch = await call('/_matrix/client/v3/account/password', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a4user', 'pw-a4-old'), new_password: 'pw-a4-new' },
  });
  assertEquals(ch.status, 200);
  const oldLogin = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-old'),
  });
  assertEquals(oldLogin.status, 403);
  assertEquals(oldLogin.body.errcode, 'M_FORBIDDEN');
  const newLogin = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-new'),
  });
  assertEquals(newLogin.status, 200);
  assertEquals(newLogin.body.user_id, u.user_id);
  // The caller's own token survives the change…
  const who = await call('/_matrix/client/v3/account/whoami', {
    token: u.access_token,
  });
  assertEquals(who.status, 200);
  assertEquals(who.body.user_id, u.user_id);
  // …the other pre-change token does not (default logout_devices).
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', { token: secondTok }))
      .status,
    401,
  );
  // logout_devices:false → other tokens survive.
  const third = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-new'),
  });
  const thirdTok = third.body.access_token as string;
  const ch2 = await call('/_matrix/client/v3/account/password', {
    method: 'POST',
    token: u.access_token,
    body: {
      auth: pwAuth('a4user', 'pw-a4-new'),
      new_password: 'pw-a4-new2',
      logout_devices: false,
    },
  });
  assertEquals(ch2.status, 200);
  assertEquals(
    (await call('/_matrix/client/v3/account/whoami', { token: thirdTok }))
      .status,
    200,
  );
});

test('A6: deactivate — flows include m.login.password; wrong pw 401 M_FORBIDDEN; right pw 200; later login 403', async () => {
  const u = await registerTestUser('a6user', 'pw-a6');
  const d1 = await call('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    token: u.access_token,
    body: {},
  });
  assertEquals(d1.status, 401);
  assert(
    (d1.body.flows as { stages: string[] }[]).some((f) =>
      f.stages.includes('m.login.password')
    ),
    `flows lack m.login.password: ${JSON.stringify(d1.body.flows)}`,
  );
  const d2 = await call('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a6user', 'WRONG') },
  });
  assertEquals(d2.status, 401);
  assertEquals(d2.body.errcode, 'M_FORBIDDEN');
  const d3 = await call('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a6user', 'pw-a6') },
  });
  assertEquals(d3.status, 200);
  assertEquals(d3.body.id_server_unbind_result, 'success');
  const login = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a6user', 'pw-a6'),
  });
  assertEquals(login.status, 403);
  assertEquals(login.body.errcode, 'M_USER_DEACTIVATED');
});
