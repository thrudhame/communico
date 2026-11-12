import type {} from '#root/api/types.d.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { resolveAlias } from '#engine/client/directory.ts';
import { joinByIdOrAlias } from '#engine/client/membership.ts';
import { userProfile } from '#engine/client/profile.ts';
import { remoteDiscoveryHierarchy } from '#engine/client/discovery.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { discoveryRequest } from '#engine/federation/discovery.ts';
import { lookupPeer } from '#engine/federation/peers.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('discovery endpoint boundaries');
type Json = Record<string, unknown>;
async function fixture(
  fn: (f: {
    fake: Awaited<ReturnType<typeof startFakeServer>>;
    answer: (value: unknown) => void;
  }) => Promise<void>,
) {
  let value: unknown;
  const fake = await startFakeServer({
    ourKeyDoc: async () =>
      await (await suite.matrix(new Request('http://x/_matrix/key/v2/server')))
        .json(),
    handlers: (request) => {
      if (request.url.pathname.startsWith('/_matrix/federation/v1/')) {
        assert(request.verified);
        return Response.json(value);
      }
      return null;
    },
  });
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  try {
    await fn({
      fake,
      answer: (next) => {
        value = next;
      },
    });
  } finally {
    setConfigForTests({});
    resetCaCertsForTests();
    await fake.close();
  }
}

suite.test('lookup and join share the same directory schema before any join effect', async () => {
  await fixture(async ({ fake, answer }) => {
    const alias = '#room:' + fake.name;
    let joins = 0;
    const operation = ((room, _user, _content, options) => {
      joins++;
      assertEquals(room, '!room:remote.test');
      assertEquals(options?.via, [fake.name, 'remote.test']);
      return Promise.resolve({ roomId: room });
    }) as typeof import('#engine/client/membership.ts').join;
    for (
      const invalid of [null, [], {}, { room_id: 'room', servers: [] }, {
        room_id: '!room:remote.test',
        servers: [false],
      }, { room_id: '!room:remote.test', servers: [''] }]
    ) {
      answer(invalid);
      for (
        const run of [
          () => resolveAlias(alias),
          () => joinByIdOrAlias(alias, '@local:test', {}, [], operation),
        ]
      ) {
        const error = await assertRejects(run, UpstreamError);
        assertEquals(error.category, 'protocol');
      }
    }
    assertEquals(joins, 0);
    answer({
      room_id: '!room:remote.test',
      servers: ['remote.test'],
      extra: true,
    });
    assertEquals(await resolveAlias(alias), {
      room_id: '!room:remote.test',
      servers: ['remote.test'],
    });
    await joinByIdOrAlias(alias, '@local:test', {}, [], operation);
    assertEquals(joins, 1);
  });
});

suite.test('profile preserves extensions and normative null absence, but refuses wrong legacy types', async () => {
  await fixture(async ({ fake, answer }) => {
    const user = '@remote:' + fake.name;
    for (const invalid of [[], null, { displayname: 7 }, { avatar_url: [] }]) {
      answer(invalid);
      assertEquals(
        (await assertRejects(() => userProfile(user), UpstreamError)).category,
        'protocol',
      );
    }
    answer({
      displayname: null,
      avatar_url: null,
      'm.tz': 'Unknown/Zone',
      custom: { nested: true },
    });
    assertEquals(await userProfile(user), {
      'm.tz': 'Unknown/Zone',
      custom: { nested: true },
    });
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
  });
});

suite.test('hierarchy requires endpoint fields without inventing empty children or public fields', async () => {
  await fixture(async ({ fake, answer }) => {
    const id = '!space:remote.test';
    const summary: Json = {
      room_id: id,
      num_joined_members: 0,
      world_readable: false,
      guest_can_join: false,
      children_state: [],
    };
    const valid = { room: summary, children: [], inaccessible_children: [] };
    for (
      const invalid of [
        { room: summary },
        { ...valid, inaccessible_children: [7] },
        { ...valid, children: [null] },
        { ...valid, room: { ...summary, world_readable: 'false' } },
        { ...valid, room: { ...summary, num_joined_members: undefined } },
        {
          ...valid,
          room: {
            ...summary,
            children_state: [{
              type: 'm.space.child',
              state_key: '!child:test',
              content: {},
            }],
          },
        },
        { ...valid, room: { ...summary, room_id: '!other:test' } },
      ]
    ) {
      answer(invalid);
      await assertRejects(
        () => remoteDiscoveryHierarchy(id, '@local:test', [fake.name]),
        UpstreamError,
      );
    }
    answer(valid);
    assertEquals(
      await remoteDiscoveryHierarchy(id, '@local:test', [fake.name]),
      { room: summary, inaccessible: [] },
    );
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
  });
});

suite.test('nonempty whitespace is invalid JSON before federation dispatch', async () => {
  const response = await suite.matrix(
    new Request('http://x/_matrix/federation/v1/send/whitespace', {
      method: 'PUT',
      body: ' \t\r\n',
    }),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).errcode, 'M_NOT_JSON');
});

suite.test('read-only discovery supports a signed POST body without adding a participant', async () => {
  await fixture(async ({ fake, answer }) => {
    answer({ chunk: [], total_room_count_estimate: 0 });
    const body = new TextEncoder().encode(
      JSON.stringify({ filter: { generic_search_term: 'test' } }),
    );
    assertEquals(
      await discoveryRequest(theApp().server, theApp().tenant.signer(), {
        destination: fake.name,
        method: 'POST',
        body,
        path: '/_matrix/federation/v1/publicRooms',
      }),
      { chunk: [], total_room_count_estimate: 0 },
    );
    assertEquals(fake.requests.at(-1)?.method, 'POST');
    assertEquals(fake.requests.at(-1)?.body, body);
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
  });
});
