import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { addBlock, lookupPeer } from '#engine/federation/peers.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { httpSuite } from '#tests/http-app.ts';
import { lookupRoom } from '#engine/client/room.ts';

const suite = httpSuite('HTTP discovery lookups');
async function fixture(
  fn: (f: {
    fake: Awaited<ReturnType<typeof startFakeServer>>;
    get: (
      path: string,
    ) => Promise<{ status: number; body: Record<string, unknown> }>;
    user: string;
    alias: string;
    profile: string;
    directory: string;
  }) => Promise<void>,
) {
  const policy = (lookups = 'all', mode = 'open') => {
    setConfigForTests({
      federation: { lookups, mode, cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    resetCaCertsForTests();
  };
  policy();
  let user = '', alias = '';
  const fake = await startFakeServer({
    ourKeyDoc: async () =>
      await (await suite.matrix(new Request('http://x/_matrix/key/v2/server')))
        .json(),
    handlers: (req) => {
      if (req.url.pathname === '/_matrix/federation/v1/query/profile') {
        assertEquals(req.verified, true);
        assertEquals(req.url.searchParams.get('user_id'), user);
        return Response.json({
          displayname: 'Remote profile',
          avatar_url: 'mxc://remote/avatar',
        });
      }
      if (req.url.pathname === '/_matrix/federation/v1/query/directory') {
        assertEquals(req.verified, true);
        assertEquals(req.url.searchParams.get('room_alias'), alias);
        return Response.json({
          room_id: '!remote:else.test',
          servers: ['else.test'],
        });
      }
      return null;
    },
  });
  user = '@caf\u00e9:' + fake.name;
  alias = '#caf\u00e9:' + fake.name;
  const get = async (path: string) => {
    const res = await suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path),
    );
    return {
      status: res.status,
      body: await res.json() as Record<string, unknown>,
    };
  };
  try {
    await fn({
      fake,
      get,
      user,
      alias,
      profile: 'profile/' + encodeURIComponent(user),
      directory: 'directory/room/' + encodeURIComponent(alias),
    });
  } finally {
    setConfigForTests({});
    resetCaCertsForTests();
    await fake.close();
  }
}

suite.test('anonymous Unicode alias and profile lookups use signed federation without retaining a peer', async () => {
  await fixture(async ({ fake, get, profile, directory }) => {
    assertEquals(await get(profile), {
      status: 200,
      body: {
        displayname: 'Remote profile',
        avatar_url: 'mxc://remote/avatar',
      },
    });
    assertEquals(await get(profile + '/displayname'), {
      status: 200,
      body: { displayname: 'Remote profile' },
    });
    assertEquals(await get(profile + '/avatar_url'), {
      status: 200,
      body: { avatar_url: 'mxc://remote/avatar' },
    });
    assertEquals(await get(directory), {
      status: 200,
      body: { room_id: '!remote:else.test', servers: ['else.test'] },
    });
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
    assertEquals(
      fake.requests.filter((r) => r.path.includes('/query/')).length,
      4,
    );
  });
});

suite.test('known/none, disabled federation, closed mode and block list gate lookup network effects', async () => {
  await fixture(async ({ fake, get, profile, directory }) => {
    for (
      const federation of [{ lookups: 'known' }, { lookups: 'none' }, {
        enabled: false,
      }]
    ) {
      setConfigForTests({ federation });
      assertEquals((await get(profile)).status, 404);
      assertEquals((await get(directory)).status, 404);
    }
    setConfigForTests({ federation: { lookups: 'all', mode: 'closed' } });
    assertEquals((await get(profile)).status, 403);
    assertEquals((await get(directory)).status, 403);
    setConfigForTests({ federation: { lookups: 'all' } });
    await addBlock(theApp().server, fake.name, 'test lookup admission');
    assertEquals((await get(profile)).status, 403);
    assertEquals((await get(directory)).status, 403);
    assertEquals(fake.requests.length, 0);
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
  });
});

suite.test('remote room summary uses signed hierarchy, rechecks user eligibility and retains no room or peer', async () => {
  const user = await suite.registerTestUser('remote-summary', 'pw');
  let roomId = '', joinRule = 'public';
  const fake = await startFakeServer({
    ourKeyDoc: async () =>
      await (await suite.matrix(new Request('http://x/_matrix/key/v2/server')))
        .json(),
    handlers: (request) => {
      if (
        request.url.pathname ===
          '/_matrix/federation/v1/hierarchy/' + encodeURIComponent(roomId)
      ) {
        assertEquals(request.verified, true);
        return Response.json({
          room: {
            room_id: roomId,
            join_rule: joinRule,
            num_joined_members: 3,
            world_readable: false,
            guest_can_join: false,
            children_state: [],
          },
          children: [],
          inaccessible_children: [],
        });
      }
      return null;
    },
  });
  roomId = '!unheld:' + fake.name;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const read = async (authenticated: boolean) => {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v1/room_summary/' +
          encodeURIComponent(roomId) + '?via=' + encodeURIComponent(fake.name),
        {
          headers: authenticated
            ? { Authorization: 'Bearer ' + user.access_token }
            : {},
        },
      ),
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    assertEquals((await read(false)).status, 404);
    assertEquals(fake.requests.length, 0);
    const visible = await read(true);
    assertEquals(visible.status, 200);
    assertEquals(visible.body.room_id, roomId);
    assertEquals(visible.body.membership, 'leave');
    assertEquals('children_state' in visible.body, false);
    joinRule = 'invite';
    assertEquals((await read(true)).status, 404);
    assertEquals(await lookupRoom(roomId), null);
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
  } finally {
    setConfigForTests({});
    resetCaCertsForTests();
    await fake.close();
  }
});
