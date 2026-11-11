import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { setConfigForTests } from '#engine/config.ts';

const { matrix, registerTestUser, test } = httpSuite('HTTP small endpoints');
async function call(path: string, token?: string) {
  const res = await matrix(
    new Request('http://x' + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('well-known client and support are explicit public settings with CORS', async () => {
  const client = '/.well-known/matrix/client';
  const support = '/.well-known/matrix/support';
  assertEquals((await call(client)).status, 404);
  assertEquals((await call(support)).status, 404);
  setConfigForTests({
    federation: { enabled: false },
    wellknown: {
      client: 'https://matrix.example/client',
      identity: 'https://identity.example/',
      support: {
        page: 'https://help.example/',
        admin: {
          mxids: ['@admin:other.example'],
          emails: ['admin@example.org'],
        },
        security: { emails: ['security@example.org'] },
      },
    },
  });
  try {
    const discovery = await call(client);
    assertEquals(discovery.status, 200);
    assertEquals(discovery.headers.get('access-control-allow-origin'), '*');
    assertEquals(discovery.body, {
      'm.homeserver': { base_url: 'https://matrix.example/client' },
      'm.identity_server': { base_url: 'https://identity.example/' },
    });
    const help = await call(support);
    assertEquals(help.status, 200);
    assertEquals(help.body, {
      contacts: [
        { role: 'm.role.admin', matrix_id: '@admin:other.example' },
        { role: 'm.role.admin', email_address: 'admin@example.org' },
        { role: 'm.role.security', email_address: 'security@example.org' },
      ],
      support_page: 'https://help.example/',
    });
  } finally {
    setConfigForTests({});
  }
});

test('TURN authenticates and returns empty configuration', async () => {
  const path = '/_matrix/client/v3/voip/turnServer';
  assertEquals((await call(path)).status, 401);
  const user = await registerTestUser('turn-reader', 'pw');
  const result = await call(path, user.access_token!);
  assertEquals(result.status, 200);
  assertEquals(result.body, {});
});

test('TURN returns static or expiring shared-secret credentials, secret wins', async () => {
  const user = await registerTestUser('turn-configured', 'pw');
  const path = '/_matrix/client/v3/voip/turnServer';
  const uris = [
    'turn:relay.example:3478?transport=udp',
    'turns:relay.example:443?transport=tcp',
  ];
  try {
    setConfigForTests({
      turn: { uris, username: 'static', password: 'static-password', ttl: 600 },
    });
    assertEquals((await call(path, user.access_token!)).body, {
      uris,
      username: 'static',
      password: 'static-password',
      ttl: 600,
    });
    setConfigForTests({
      turn: {
        uris,
        secret: 'shared-secret',
        username: 'ignored',
        password: 'ignored',
        ttl: 600,
      },
    });
    const before = Math.floor(Date.now() / 1000);
    const result = await call(path, user.access_token!);
    assertEquals(result.status, 200);
    const expiry = Number(result.body.username.split(':')[0]);
    assert(
      expiry >= before + 600 && expiry <= Math.floor(Date.now() / 1000) + 600,
    );
    assertEquals(result.body.username, `${expiry}:${user.user_id}`);
    // Independent WebCrypto verification, including standard padded base64.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('shared-secret'),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(result.body.username),
    );
    assertEquals(
      result.body.password,
      btoa(String.fromCharCode(...new Uint8Array(signature))),
    );
    assertEquals(result.body.uris, uris);
    assertEquals(result.body.ttl, 600);
    for (
      const turn of [{ uris, username: 'incomplete' }, {
        uris,
        secret: 's',
        ttl: 0,
      }, { secret: 's' }]
    ) {
      setConfigForTests({ turn });
      assertEquals((await call(path, user.access_token!)).body, {});
    }
  } finally {
    setConfigForTests({});
  }
});

test('well-known support can advertise only contacts or only a page', async () => {
  try {
    setConfigForTests({
      wellknown: { support: { admin: { emails: ['admin@example.org'] } } },
    });
    const contacts = await call('/.well-known/matrix/support');
    assertEquals(contacts.status, 200);
    assertEquals(contacts.headers.get('access-control-allow-origin'), '*');
    assertEquals(contacts.body, {
      contacts: [{ role: 'm.role.admin', email_address: 'admin@example.org' }],
    });
    setConfigForTests({
      wellknown: { support: { page: 'https://help.example/' } },
    });
    assertEquals((await call('/.well-known/matrix/support')).body, {
      support_page: 'https://help.example/',
    });
    setConfigForTests({ wellknown: { client: 'https://matrix.example/' } });
    assertEquals((await call('/.well-known/matrix/client')).body, {
      'm.homeserver': { base_url: 'https://matrix.example/' },
    });
  } finally {
    setConfigForTests({});
  }
});

test('global push rules share the complete ruleset owner', async () => {
  const path = '/_matrix/client/v3/pushrules/global/';
  assertEquals((await call(path)).status, 401);
  const user = await registerTestUser('global-reader', 'pw');
  const all = await call('/_matrix/client/v3/pushrules/', user.access_token!);
  const global = await call(path, user.access_token!);
  assertEquals(global.status, 200);
  assertEquals(global.body, all.body.global);
});

test('whois permits self with no recorded connections and refuses other users', async () => {
  const alice = await registerTestUser('whois-alice', 'pw');
  const bob = await registerTestUser('whois-bob', 'pw');
  const path = '/_matrix/client/v3/admin/whois/' +
    encodeURIComponent(alice.user_id);
  assertEquals((await call(path)).status, 401);
  assertEquals((await call(path, bob.access_token!)).status, 403);
  const own = await call(path, alice.access_token!);
  assertEquals(own.status, 200);
  assertEquals(own.body, {
    user_id: alice.user_id,
    devices: { [alice.device_id!]: { sessions: [{ connections: [] }] } },
  });
});

test('whois administrator grants are explicit and sessions follow token/device lifecycle', async () => {
  const admin = await registerTestUser('whois-admin', 'pw');
  const user = await registerTestUser('whois-target', 'pw');
  const path = '/_matrix/client/v3/admin/whois/' +
    encodeURIComponent(user.user_id);
  const login = await matrix(
    new Request('http://x/_matrix/client/v3/login', {
      method: 'POST',
      body: JSON.stringify({
        type: 'm.login.password',
        user: 'whois-target',
        password: 'pw',
        device_id: '__proto__',
      }),
    }),
  );
  assertEquals(login.status, 200);
  const session = await login.json();
  setConfigForTests({ admin: { users: [admin.user_id] } });
  try {
    const result = await call(path, admin.access_token!);
    assertEquals(result.status, 200);
    assertEquals(
      Object.keys(result.body.devices).sort(),
      [user.device_id!, '__proto__'].sort(),
    );
    assertEquals(result.body.devices.__proto__, {
      sessions: [{ connections: [] }],
    });
    assertEquals(JSON.stringify(result.body).includes('user_agent'), false);
    const logout = await matrix(
      new Request('http://x/_matrix/client/v3/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
    );
    assertEquals(logout.status, 200);
    await logout.body?.cancel();
    assertEquals(
      Object.hasOwn(
        (await call(path, admin.access_token!)).body.devices,
        '__proto__',
      ),
      false,
    );
    assertEquals(
      (await call(
        '/_matrix/client/v3/admin/whois/' +
          encodeURIComponent('@missing:localhost'),
        admin.access_token!,
      )).body,
      { user_id: '@missing:localhost', devices: {} },
    );
    assertEquals(
      (await call(
        '/_matrix/client/v3/admin/whois/' +
          encodeURIComponent('@remote:elsewhere'),
        admin.access_token!,
      )).status,
      400,
    );
  } finally {
    setConfigForTests({});
  }
  assertEquals((await call(path, admin.access_token!)).status, 403);
});
