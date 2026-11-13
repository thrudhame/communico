// HTTP contracts for the account-data/profile/filter/discovery doors.
// The old account/pushrules cases live in their restored suites; these
// cover the remaining public/protected splits and storage round-trips.
import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP client data');
type Json = Record<string, unknown>;

async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
) {
  const response = await matrix(
    new Request('http://x' + path, {
      method,
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

test('known-only profile policy returns 404 M_NOT_FOUND for an unknown foreign user', async () => {
  setConfigForTests({ federation: { lookups: 'known' } });
  try {
    const res = await matrix(
      new Request('http://x/_matrix/client/v3/profile/@nobody:x'),
    );
    assertEquals(res.status, 404);
    assertEquals((await res.json()).errcode, 'M_NOT_FOUND');
  } finally {
    setConfigForTests({});
  }
});

test('local profile: public combined reads, self-only writes, deletion and absent keys', async () => {
  const a = await registerTestUser('data-profile', 'pw');
  const b = await registerTestUser('data-other', 'pw');
  const base = '/_matrix/client/v3/profile/' + encodeURIComponent(a.user_id);
  // The local-user half of federation-endpoints.test.ts's CS lookups.
  assertEquals(await call(base), {
    status: 200,
    body: { displayname: 'data-profile' },
  });
  for (const field of ['displayname', 'avatar_url']) {
    const url = base + '/' + field;
    const value = field === 'avatar_url'
      ? 'mxc://localhost/profile'
      : 'verbatim';
    assertEquals((await call(url, 'PUT', { [field]: 'no-token' })).status, 401);
    assertEquals(
      (await call(url, 'PUT', { [field]: 'other' }, b.access_token)).status,
      403,
    );
    assertEquals(
      (await call(url, 'PUT', { [field]: 42 }, a.access_token)).status,
      400,
    );
    assertEquals(
      (await call(url, 'PUT', { [field]: value }, a.access_token)).status,
      200,
    );
    assertEquals((await call(url)).body, { [field]: value });
    if (field === 'avatar_url') {
      const invalid = await call(url, 'PUT', { [field]: null }, a.access_token);
      assertEquals(invalid.status, 400);
      assertEquals(invalid.body.errcode, 'M_INVALID_PARAM');
      assertEquals((await call(url)).body, { [field]: value });
      assertEquals(
        (await call(url, 'DELETE', undefined, a.access_token)).status,
        200,
      );
    } else {
      assertEquals(
        (await call(url, 'PUT', { [field]: null }, a.access_token)).status,
        200,
      );
    }
    assertEquals((await call(url)).body, {});
  }
  assertEquals((await call(base)).body, {});
  const missing = '/_matrix/client/v3/profile/@absent:' + a.home_server;
  for (const suffix of ['', '/displayname', '/avatar_url']) {
    const response = await call(missing + suffix);
    assertEquals(response.status, 404);
    assertEquals(response.body.errcode, 'M_NOT_FOUND');
  }
});

test('filters: store/get verbatim, validation, owner isolation and missing filter', async () => {
  const a = await registerTestUser('filter-a', 'pw');
  const b = await registerTestUser('filter-b', 'pw');
  const base = '/_matrix/client/v3/user/' + encodeURIComponent(a.user_id) +
    '/filter';
  const document = {
    room: { timeline: { limit: 3, types: ['m.room.message'] } },
    custom: { kept: true },
  };
  const created = await call(base, 'POST', document, a.access_token);
  assertEquals(created.status, 200);
  assert(typeof created.body.filter_id === 'string');
  const stored = await call(
    base + '/' + created.body.filter_id,
    'GET',
    undefined,
    a.access_token,
  );
  assertEquals(stored, { status: 200, body: document });
  assertEquals(
    (await call(
      base + '/' + created.body.filter_id,
      'GET',
      undefined,
      b.access_token,
    )).status,
    403,
  );
  assertEquals((await call(base, 'POST', {}, b.access_token)).status, 403);
  const missing = await call(
    base + '/unknown',
    'GET',
    undefined,
    a.access_token,
  );
  assertEquals(missing.status, 404);
  assertEquals(missing.body.errcode, 'M_NOT_FOUND');
  const bad = await call(
    base,
    'POST',
    { room: { timeline: { limit: -1 } } },
    a.access_token,
  );
  assertEquals(bad.status, 400);
  assertEquals(bad.body.errcode, 'M_BAD_JSON');
  assertEquals((await call(base, 'POST', {})).status, 401);
});

test('account data: all owner checks and server-controlled types, room scope isolation', async () => {
  const a = await registerTestUser('data-a', 'pw');
  const b = await registerTestUser('data-b', 'pw');
  const base = '/_matrix/client/v3/user/' + encodeURIComponent(a.user_id);
  const scopes = [base, base + '/rooms/!opaque:localhost'];
  for (const scope of scopes) {
    const url = scope + '/account_data/test';
    assertEquals(
      (await call(url, 'PUT', { x: true }, b.access_token)).status,
      403,
    );
    assertEquals(
      (await call(url, 'GET', undefined, b.access_token)).status,
      403,
    );
    assertEquals(
      (await call(url, 'GET', undefined, a.access_token)).status,
      404,
    );
    for (const type of ['m.push_rules', 'm.fully_read']) {
      const response = await call(
        scope + '/account_data/' + type,
        'PUT',
        {},
        a.access_token,
      );
      assertEquals(response.status, 405);
      assertEquals(response.body.errcode, 'M_BAD_JSON');
    }
  }
  assertEquals(
    (await call(
      base + '/account_data/test',
      'PUT',
      { global: true },
      a.access_token,
    )).status,
    200,
  );
  assertEquals(
    (await call(
      scopes[1] + '/account_data/test',
      'GET',
      undefined,
      a.access_token,
    )).status,
    404,
  );
});

test('pushers: upsert, omission of optional profile_tag, no token disclosure, kind null deletes', async () => {
  const a = await registerTestUser('data-pusher', 'pw');
  const pusher = {
    app_id: 'app',
    pushkey: 'key',
    kind: 'http',
    app_display_name: 'app',
    device_display_name: 'device',
    lang: 'en',
    data: { url: 'https://never-fetched.invalid/_matrix/push/v1/notify' },
  };
  const set = (body: unknown) =>
    call('/_matrix/client/v3/pushers/set', 'POST', body, a.access_token);
  assertEquals((await set(pusher)).status, 200);
  assertEquals(
    (await set({ ...pusher, device_display_name: 'renamed' })).status,
    200,
  );
  const list = await call(
    '/_matrix/client/v3/pushers',
    'GET',
    undefined,
    a.access_token,
  );
  assertEquals(list.body, {
    pushers: [{ ...pusher, device_display_name: 'renamed' }],
  });
  assertEquals(
    (await set({ app_id: 'app', pushkey: 'key', kind: null })).status,
    200,
  );
  assertEquals(
    (await call('/_matrix/client/v3/pushers', 'GET', undefined, a.access_token))
      .body,
    { pushers: [] },
  );
  const bad = await set({ app_id: 'app' });
  assertEquals(bad.status, 400);
  assertEquals(bad.body.errcode, 'M_MISSING_PARAM');
});

test('versions stays public, capabilities stays protected, discovery absent per Addendum B', async () => {
  assertEquals(await call('/_matrix/client/versions'), {
    status: 200,
    body: {
      versions: [
        'v1.1',
        'v1.2',
        'v1.3',
        'v1.4',
        'v1.5',
        'v1.6',
        'v1.7',
        'v1.8',
        'v1.9',
        'v1.10',
        'v1.11',
        'v1.12',
        'v1.13',
        'v1.14',
        'v1.15',
        'v1.16',
      ],
      unstable_features: {
        'org.matrix.simplified_msc3575': true,
        'org.matrix.msc4143': false,
        'org.matrix.msc4140': false,
        'uk.tcpip.msc4133.stable': true,
        'io.element.e2ee_forced.public': !config().encryption
          .allowunencryptedcreation,
        'io.element.e2ee_forced.private': !config().encryption
          .allowunencryptedcreation,
        'io.element.e2ee_forced.trusted_private': !config().encryption
          .allowunencryptedcreation,
      },
    },
  });
  const url = '/_matrix/client/v3/capabilities';
  assertEquals((await call(url)).status, 401);
  const a = await registerTestUser('data-caps', 'pw');
  const response = await call(url, 'GET', undefined, a.access_token);
  assertEquals(response.status, 200);
  const available = Object.fromEntries(
    ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map((
      v,
    ) => [v, 'stable']),
  );
  assertEquals(response.body, {
    capabilities: {
      'm.room_versions': { default: '11', available },
      'm.change_password': { enabled: false },
      'm.profile_fields': { enabled: true },
      'm.set_displayname': { enabled: true },
      'm.set_avatar_url': { enabled: true },
      'org.matrix.msc4140.delayed_events': {
        max_delay_ms: 0,
        max_scheduled: 100,
      },
    },
  });
  for (const path of ['client', 'server']) {
    const discovery = await matrix(
      new Request('http://x/.well-known/matrix/' + path),
    );
    assertEquals(discovery.status, 404);
    await discovery.text();
  }
});
