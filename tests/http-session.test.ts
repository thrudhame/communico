// Registration/session wire contracts beyond the old account.test.ts
// cases: exercise the real public entry points, not engine seeding.
import { assert, assertEquals } from '@std/assert';
import { serverName } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';

const { matrix, test, registerTestUser } = httpSuite(
  'HTTP registration and session lifecycle',
);
type Json = Record<string, unknown>;
async function call(path: string, method = 'GET', body?: Json, token?: string) {
  const res = await matrix(
    new Request('http://x/_matrix/client/' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}

test('r0 and v3 login adapters issue usable device-bound tokens through the same session owner', async () => {
  const user = await registerTestUser('login-alias', 'pw');
  for (const version of ['r0', 'v3']) {
    const session = await call(version + '/login', 'POST', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: user.user_id },
      password: 'pw',
      device_id: 'alias-' + version,
    });
    assertEquals(session.status, 200);
    const token = session.body.access_token as string;
    assertEquals(
      (await call('v3/account/whoami', 'GET', undefined, token)).body,
      {
        user_id: user.user_id,
        device_id: 'alias-' + version,
      },
    );
    assertEquals((await call('v3/logout', 'POST', {}, token)).status, 200);
    assertEquals(
      (await call('v3/account/whoami', 'GET', undefined, token)).status,
      401,
    );
  }
});

test('registration availability, validation before UIA, inhibit_login; login/logout and logout/all', async () => {
  for (const version of ['v3', 'r0']) {
    const flows = await call(version + '/login');
    assertEquals(flows.status, 200);
    assertEquals(flows.body, { flows: [{ type: 'm.login.password' }] });
  }
  assertEquals((await call('v3/register')).body, {
    flows: [{ stages: ['m.login.dummy'] }],
  });
  const available = await call('v3/register/available?username=Sessions');
  assertEquals(available, { status: 200, body: { available: true } });
  const invalid = await call('v3/register', 'POST', { username: 'bad name' });
  assertEquals(invalid.status, 400);
  assertEquals(invalid.body.errcode, 'M_INVALID_USERNAME');
  const input = {
    username: 'Sessions',
    password: 'pw',
    device_id: 'inhibited',
    inhibit_login: true,
  };
  const challenge = await call('v3/register', 'POST', input);
  assertEquals(challenge.status, 401);
  assertEquals(Object.keys(challenge.body).sort(), [
    'flows',
    'params',
    'session',
  ]);
  const registered = await call('v3/register', 'POST', {
    ...input,
    auth: { type: 'm.login.dummy', session: challenge.body.session },
  });
  assertEquals(registered.status, 200);
  assertEquals(registered.body, {
    user_id: `@sessions:${serverName()}`,
    home_server: serverName(),
  });
  const taken = await call('v3/register', 'POST', { username: 'Sessions' });
  assertEquals(taken.status, 400);
  assertEquals(taken.body.errcode, 'M_USER_IN_USE');
  assertEquals(
    (await call('v3/register/available?username=sessions')).body.errcode,
    'M_USER_IN_USE',
  );
  const login = (extra: Json = {}) =>
    call('v3/login', 'POST', {
      type: 'm.login.password',
      user: 'SESSIONS',
      password: 'pw',
      ...extra,
    });
  const wrong = await login({ password: 'wrong' });
  assertEquals(wrong.status, 403);
  assertEquals(wrong.body.errcode, 'M_FORBIDDEN');
  const foreign = await login({ user: '@sessions:foreign.test' });
  assertEquals(foreign.status, 403);
  const first = await login({ device_id: 'first' });
  const second = await login({ device_id: 'second' });
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  const firstToken = first.body.access_token as string;
  const secondToken = second.body.access_token as string;
  assertEquals(
    (await call('v3/account/whoami?access_token=' + firstToken)).body,
    { user_id: registered.body.user_id, device_id: 'first' },
  );
  const logout = await call('v3/logout', 'POST', undefined, secondToken);
  assertEquals(logout, { status: 200, body: {} });
  assertEquals(
    (await call('v3/account/whoami', 'GET', undefined, secondToken)).status,
    401,
  );
  const devices = await call('v3/devices', 'GET', undefined, firstToken);
  assertEquals(
    (devices.body.devices as Json[]).map((d) => d.device_id).sort(),
    ['first'],
  );
  assertEquals(await call('v3/logout/all', 'POST', undefined, firstToken), {
    status: 200,
    body: {},
  });
  assertEquals(
    (await call('v3/account/whoami', 'GET', undefined, firstToken)).status,
    401,
  );
  const after = await login({ device_id: 'after' });
  const afterDevices = await call(
    'v3/devices',
    'GET',
    undefined,
    after.body.access_token as string,
  );
  assertEquals((afterDevices.body.devices as Json[]).map((d) => d.device_id), [
    'after',
  ]);
  // There were no email/msisdn issuance handlers on doltgres.
  for (const medium of ['email', 'msisdn']) {
    const stub = await call(`v3/register/${medium}/requestToken`, 'POST', {});
    assertEquals(stub.status, 404);
    assertEquals(stub.body.errcode, 'M_UNRECOGNIZED');
  }
});

test('delete_devices: UIA, ownership and batch token revocation', async () => {
  const body = { username: 'batch', password: 'pw' };
  const session = await call('v3/register', 'POST', body);
  const reg = await call('v3/register', 'POST', {
    ...body,
    auth: { type: 'm.login.dummy', session: session.body.session },
  });
  assertEquals(reg.status, 200);
  const token = reg.body.access_token as string;
  assert(typeof token === 'string');
  const auth = { type: 'm.login.password', password: 'pw' };
  const tokens: string[] = [];
  for (const device of ['d1', 'd2']) {
    const res = await call('v3/login', 'POST', {
      type: 'm.login.password',
      user: 'batch',
      password: 'pw',
      device_id: device,
    });
    assertEquals(res.status, 200);
    tokens.push(res.body.access_token as string);
  }
  assertEquals(
    (await call('v3/delete_devices', 'POST', { devices: ['d1', 'd2'] }, token))
      .status,
    401,
  );
  assertEquals(
    await call(
      'v3/delete_devices',
      'POST',
      { devices: ['d1', 'd2'], auth },
      token,
    ),
    { status: 200, body: {} },
  );
  for (const dead of tokens) {
    assertEquals(
      (await call('v3/account/whoami', 'GET', undefined, dead)).status,
      401,
    );
  }
  const list = await call('v3/devices', 'GET', undefined, token);
  assertEquals((list.body.devices as Json[]).map((d) => d.device_id), [
    reg.body.device_id,
  ]);
});
