import { assertEquals, assertThrows } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { lookupRoom } from '#engine/client/room.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { lookupPeer } from '#engine/federation/peers.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import {
  decodeDirectoryRequest,
  directoryDestination,
  directoryWireRequest,
} from '#engine/client/directory-request.ts';

const suite = httpSuite('HTTP remote public directory');
let signingPeer: Awaited<ReturnType<typeof remoteServer>> | undefined;
async function federationCaller() {
  if (signingPeer === undefined) signingPeer = await remoteServer();
  return fedCaller(suite.matrix, signingPeer);
}
type Json = Record<string, unknown>;
async function call(
  server: string,
  token?: string,
  body?: unknown,
  query = '',
) {
  const response = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/publicRooms?server=' +
        encodeURIComponent(server) + query,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: token === undefined
          ? {}
          : { Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ),
  );
  return { status: response.status, body: await response.json() as Json };
}

async function fixture(
  run: (f: {
    peers: Awaited<ReturnType<typeof startFakeServer>>[];
    seen: { peer: number; method: string; query: Json; body: unknown }[];
    token: string;
    answer: (value: unknown, status?: number) => void;
  }) => Promise<void>,
) {
  const user = await suite.registerTestUser(
    'remote-directory-' + crypto.randomUUID(),
    'pw',
  );
  const seen: { peer: number; method: string; query: Json; body: unknown }[] =
    [];
  let override: { value: unknown; status: number } | undefined;
  const peers: Awaited<ReturnType<typeof startFakeServer>>[] = [];
  for (const peer of [0, 1]) {
    peers.push(
      await startFakeServer({
        ourKeyDoc: async () =>
          await (await suite.matrix(
            new Request('http://x/_matrix/key/v2/server'),
          )).json(),
        handlers: (request) => {
          if (
            request.url.pathname !== '/_matrix/federation/v1/publicRooms'
          ) return null;
          assertEquals(request.verified, true, 'directory request is signed');
          seen.push({
            peer,
            method: request.method,
            query: Object.fromEntries(request.url.searchParams),
            body: request.json(),
          });
          return Response.json(
            override === undefined
              ? {
                chunk: [{
                  room_id: '!directory-' + peer + ':remote.test',
                  name: 'Remote ' + peer,
                  num_joined_members: peer + 1,
                  world_readable: false,
                  guest_can_join: false,
                }],
                next_batch: 'opaque/+?=' + peer,
                prev_batch: 'previous:' + peer,
                total_room_count_estimate: peer + 3,
              }
              : override.value,
            { status: override === undefined ? 200 : override.status },
          );
        },
      }),
    );
  }
  setConfigForTests({
    federation: {
      lookups: 'all',
      mode: 'open',
      cacerts: ['tests/fixtures/tls/ca.crt'],
    },
  });
  resetCaCertsForTests();
  try {
    await run({
      peers,
      seen,
      token: user.access_token!,
      answer: (value, status = 200) => override = { value, status },
    });
    for (const peer of peers) {
      assertEquals(await lookupPeer(theApp().server, peer.name), null);
    }
    assertEquals(await lookupRoom('!directory-0:remote.test'), null);
    assertEquals(await lookupRoom('!directory-1:remote.test'), null);
  } finally {
    setConfigForTests({});
    resetCaCertsForTests();
    for (const peer of peers) await peer.close();
  }
}

suite.test('GET and POST select two remote directories and preserve opaque cursors and every selector', async () => {
  await fixture(async ({ peers, seen, token }) => {
    for (const [index, peer] of peers.entries()) {
      const result = await call(
        peer.name,
        token,
        undefined,
        '&limit=0&since=' + encodeURIComponent('opaque/+?=' + index),
      );
      assertEquals(result.status, 200);
      assertEquals((result.body.chunk as Json[]).map((room) => room.room_id), [
        '!directory-' + index + ':remote.test',
      ]);
      assertEquals(result.body.next_batch, 'opaque/+?=' + index);
      assertEquals(result.body.prev_batch, 'previous:' + index);
      assertEquals(result.body.total_room_count_estimate, index + 3);
      assertEquals(seen.at(-1), {
        peer: index,
        method: 'GET',
        query: { limit: '0', since: 'opaque/+?=' + index },
        body: null,
      });
      for (
        const network of [{}, { include_all_networks: true }, {
          third_party_instance_id: 'bridge:opaque',
        }]
      ) {
        const body = {
          limit: 2,
          since: 'remote:continuation',
          filter: {
            generic_search_term: 'Remote',
            room_types: [null, 'm.space'],
            'org.example.extension': true,
          },
          ...network,
        };
        const post = await call(peer.name, token, body);
        assertEquals(post.status, 200);
        assertEquals(
          (post.body.chunk as Json[])[0].room_id,
          '!directory-' + index + ':remote.test',
        );
        assertEquals(seen.at(-1), {
          peer: index,
          method: 'POST',
          query: {},
          body,
        });
      }
    }
  });
});

suite.test('refusal and invalid remote success are errors, never a local directory fallback', async () => {
  await fixture(async ({ peers, token, answer }) => {
    answer({ errcode: 'M_FORBIDDEN', error: 'directory disabled' }, 403);
    const refusal = await call(peers[0].name, token);
    assertEquals([refusal.status, refusal.body.errcode], [403, 'M_FORBIDDEN']);
    for (
      const value of [
        null,
        [],
        {},
        { chunk: {} },
        { chunk: [{ room_id: '!bad:remote.test' }] },
        { chunk: [], next_batch: 1 },
        { chunk: [], total_room_count_estimate: 0.5 },
      ]
    ) {
      answer(value);
      const response = await call(peers[0].name, token, {});
      assertEquals(response.status, 502, JSON.stringify(value));
      assertEquals('chunk' in response.body, false);
    }
    answer({ chunk: [] });
    assertEquals(await call(peers[0].name, token), {
      status: 200,
      body: { chunk: [] },
    });
  });
});

suite.test('lookup policy gates remote directories without returning local publication or adding intent', async () => {
  await fixture(async ({ peers, seen, token }) => {
    for (
      const federation of [{ lookups: 'known' }, { lookups: 'none' }, {
        enabled: false,
      }, { mode: 'closed' }]
    ) {
      setConfigForTests({ federation });
      assertEquals((await call(peers[0].name, token)).status, 403);
    }
    assertEquals(seen.length, 0);
    assertEquals(
      await theApp().server.query('SELECT * FROM federation_pending'),
      [],
    );
  });
});

suite.test('client authentication and inbound publication are independent Synapse-default settings', async () => {
  const user = await suite.registerTestUser('directory-auth', 'pw');
  const fed = await federationCaller();
  try {
    setConfigForTests({});
    assertEquals((await call('')).status, 401);
    assertEquals((await call('', user.access_token)).status, 200);
    assertEquals((await call('', undefined, {})).status, 401);
    for (const method of ['GET', 'POST']) {
      assertEquals(
        (await fed(
          method,
          '/_matrix/federation/v1/publicRooms',
          method === 'POST' ? {} : undefined,
        )).status,
        403,
      );
    }
    setConfigForTests({ directory: { allowanonymous: true } });
    assertEquals((await call('')).status, 200);
    assertEquals(
      (await call(user.home_server!)).status,
      401,
      'explicit self server still requires authentication',
    );
    assertEquals((await call('else.test')).status, 401);
    assertEquals((await call('', undefined, {})).status, 401);
    setConfigForTests({ federation: { publicrooms: true } });
    assertEquals(
      (await call('')).status,
      401,
      'inbound publication does not enable anonymous clients',
    );
    for (const method of ['GET', 'POST']) {
      assertEquals(
        (await fed(
          method,
          '/_matrix/federation/v1/publicRooms?server=unrequested.test',
          method === 'POST' ? {} : undefined,
        )).status,
        200,
        'federation only serves the local directory',
      );
    }
  } finally {
    setConfigForTests({});
  }
});

suite.test('each directory HTTP spelling rejects all malformed known fields and local cursor suffixes', async () => {
  const user = await suite.registerTestUser('directory-negatives', 'pw');
  const fed = await federationCaller();
  setConfigForTests({ federation: { publicrooms: true } });
  try {
    const queries = [
      'limit=1.5',
      'limit=no',
      'limit=-1',
      'limit=9007199254740992',
      'since=1junk',
      'since=-1',
      'include_all_networks=no',
      'include_all_networks=true&third_party_instance_id=x',
    ];
    for (const query of queries) {
      assertEquals(
        (await call('', user.access_token, undefined, '&' + query)).status,
        400,
        'CS GET ' + query,
      );
      assertEquals(
        (await fed('GET', '/_matrix/federation/v1/publicRooms?' + query))
          .status,
        400,
        'SS GET ' + query,
      );
    }
    const bodies = [
      null,
      [],
      1,
      { limit: 1.5 },
      { limit: '1' },
      { limit: null },
      { limit: -1 },
      { since: 1 },
      { since: '1junk' },
      { filter: [] },
      { filter: null },
      { filter: 1 },
      { filter: { generic_search_term: null } },
      { filter: { generic_search_term: 3 } },
      { filter: { room_types: ['m.space', 1] } },
      { filter: { room_types: 'm.space' } },
      { include_all_networks: 'true' },
      { third_party_instance_id: 2 },
      { include_all_networks: true, third_party_instance_id: 'x' },
    ];
    for (const body of bodies) {
      assertEquals(
        (await call('', user.access_token, body)).status,
        400,
        'CS POST ' + JSON.stringify(body),
      );
      if (
        typeof body === 'object' && body !== null && 'limit' in body &&
        body.limit === 1.5
      ) {
        assertThrows(() => decodeDirectoryRequest(new URLSearchParams(), body));
      } else {
        assertEquals(
          (await fed('POST', '/_matrix/federation/v1/publicRooms', body))
            .status,
          400,
          'SS POST ' + JSON.stringify(body),
        );
      }
    }
    for (
      const server of [
        'bad/path',
        'user@host',
        'host:0',
        'host:65536',
        '[not-ip]',
        'https://host',
      ]
    ) {
      assertEquals(
        (await call(server, user.access_token)).status,
        400,
        'CS GET server ' + server,
      );
      assertEquals(
        (await call(server, user.access_token, {})).status,
        400,
        'CS POST server ' + server,
      );
    }
  } finally {
    setConfigForTests({});
  }
});

Deno.test('directory decoder preserves meaningful defaults and hands complete normalized selectors to its owner', () => {
  assertEquals(decodeDirectoryRequest(new URLSearchParams()), {
    network: { kind: 'native' },
  });
  assertEquals(
    directoryDestination(new URLSearchParams('server=%5B%3A%3A1%5D%3A8448')),
    '[::1]:8448',
  );
  assertEquals(directoryDestination(new URLSearchParams('server=')), undefined);
  for (
    const [wire, network] of [
      [{}, { kind: 'native' }],
      [{ include_all_networks: false }, { kind: 'native' }],
      [{ include_all_networks: true }, { kind: 'all' }],
      [{ third_party_instance_id: '' }, { kind: 'instance', id: '' }],
    ] as const
  ) {
    const request = decodeDirectoryRequest(new URLSearchParams(), {
      limit: 0,
      since: 'opaque:remote',
      filter: { room_types: [null], 'org.example': 7 },
      ...wire,
    });
    assertEquals(request, {
      limit: 0,
      since: 'opaque:remote',
      filter: { room_types: [null], 'org.example': 7 },
      network,
    });
    const encoded = directoryWireRequest(request);
    assertEquals(encoded.since, 'opaque:remote');
    assertEquals(encoded.filter, { room_types: [null], 'org.example': 7 });
  }
});
