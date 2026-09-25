// tests/federation-endpoints.test.ts — the stateless federation endpoints:
// /version; /query/profile (200/400/404); /query/directory (200/400/404,
// raw URI for Unicode aliases); /publicRooms GET+POST; /.well-known plain
// 404; and CS lookups answering 404 for remote user/alias with NO
// federation request made.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName, setConfigForTests } from '#engine/config.ts';
import {
  resetCaCertsForTests,
  wireFederationTransport,
} from '#engine/federation/client.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { registerTestUser, resetUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

function withFixtureCa(): void {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
}

function clearFixtureCa(): void {
  setConfigForTests({ federation: { cacerts: [] } });
  resetCaCertsForTests();
}

async function inProcessKeyDoc(): Promise<unknown> {
  const res = await matrix(
    new Request('http://x/_matrix/key/v2/server'),
  );
  return await res.json();
}

async function headerFor(
  fake: FakeServer,
  method: string,
  target: string,
): Promise<string> {
  const obj: Record<string, unknown> = {
    method,
    uri: target,
    origin: fake.name,
    destination: serverName(),
  };
  const signed = await fake.sign(obj);
  const sig = (signed.signatures as Record<string, Record<string, string>>)[
    fake.name
  ][fake.keyId];
  return `X-Matrix origin="${fake.name}",key="${fake.keyId}",sig="${sig}"`;
}

async function withFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  wireFederationTransport();
  withFixtureCa();
  const fake = await startFakeServer({ ourKeyDoc: inProcessKeyDoc });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
    clearFixtureCa();
  }
}

Deno.test('endpoints: /version public without auth', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/federation/v1/version'),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.server.name, 'communico');
});

Deno.test('endpoints: /query/profile 200 local, 400 malformed domain, 404 unknown', async () => {
  await registerTestUser('fed-ep-alice', 'pass');
  await withFake(async (fake) => {
    const good =
      '/_matrix/federation/v1/query/profile?user_id=@fed-ep-alice:localhost';
    const res = await matrix(
      new Request('http://x' + good, {
        headers: { Authorization: await headerFor(fake, 'GET', good) },
      }),
    );
    assertEquals(res.status, 200);
    const badDomain =
      '/_matrix/federation/v1/query/profile?user_id=@user1:localhost:http';
    const bad = await matrix(
      new Request('http://x' + badDomain, {
        headers: { Authorization: await headerFor(fake, 'GET', badDomain) },
      }),
    );
    assertEquals(bad.status, 400);
    const missing =
      '/_matrix/federation/v1/query/profile?user_id=@nobody:localhost';
    const miss = await matrix(
      new Request('http://x' + missing, {
        headers: { Authorization: await headerFor(fake, 'GET', missing) },
      }),
    );
    assertEquals(miss.status, 404);
  });
  await resetUser('fed-ep-alice');
});

Deno.test('endpoints: /query/directory 200 with the correct signature over the raw URI, 400 non-local, 404 unknown', async () => {
  const u = await registerTestUser('fed-ep-di', 'pass');
  const name = `#fed-ep-di:${serverName()}`;
  const create = await matrix(
    new Request('http://x/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ room_alias_name: 'fed-ep-di' }),
    }),
  );
  assertEquals(create.status, 200);
  await withFake(async (fake) => {
    const good = `/_matrix/federation/v1/query/directory?room_alias=${
      encodeURIComponent(name)
    }`;
    const res = await matrix(
      new Request('http://x' + good, {
        headers: { Authorization: await headerFor(fake, 'GET', good) },
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(typeof body.room_id === 'string');
    assertEquals(body.servers, [serverName()]);
    const badDomain = '/_matrix/federation/v1/query/directory?room_alias=' +
      encodeURIComponent('#x:else.test');
    const bad = await matrix(
      new Request('http://x' + badDomain, {
        headers: { Authorization: await headerFor(fake, 'GET', badDomain) },
      }),
    );
    assertEquals(bad.status, 400);
    const missing =
      '/_matrix/federation/v1/query/directory?room_alias=%23nobody%3Alocalhost';
    const miss = await matrix(
      new Request('http://x' + missing, {
        headers: { Authorization: await headerFor(fake, 'GET', missing) },
      }),
    );
    assertEquals(miss.status, 404);
  });
  await resetUser('fed-ep-di');
});

Deno.test('endpoints: /publicRooms GET and POST signed', async () => {
  const u = await registerTestUser('fed-ep-pub', 'pass');
  const room = await matrix(
    new Request('http://x/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room_alias_name: 'fed-ep-pub',
        visibility: 'public',
      }),
    }),
  );
  assertEquals(room.status, 200);
  await withFake(async (fake) => {
    const target = '/_matrix/federation/v1/publicRooms';
    const res = await matrix(
      new Request('http://x' + target, {
        headers: { Authorization: await headerFor(fake, 'GET', target) },
      }),
    );
    assertEquals(res.status, 200);
    // POST body content is signed — the middleware then matches it
    const signedBody = JSON.stringify({
      filter: { generic_search_term: 'pub' },
    });
    const postTarget = '/_matrix/federation/v1/publicRooms';
    const obj: Record<string, unknown> = {
      method: 'POST',
      uri: postTarget,
      origin: fake.name,
      destination: serverName(),
      content: JSON.parse(signedBody),
    };
    const signed = await fake.sign(obj);
    const sig = (signed.signatures as Record<string, Record<string, string>>)[
      fake.name
    ][fake.keyId];
    const post = await matrix(
      new Request('http://x' + postTarget, {
        method: 'POST',
        headers: {
          Authorization:
            `X-Matrix origin="${fake.name}",key="${fake.keyId}",sig="${sig}"`,
        },
        body: signedBody,
      }),
    );
    assertEquals(post.status, 200);
    const body = await post.json();
    assert(Array.isArray(body.chunk));
  });
  await resetUser('fed-ep-pub');
});

Deno.test('endpoints: /.well-known is a plain 404 in default config', async () => {
  const res = await matrix(new Request('http://x/.well-known/matrix/server'));
  assertEquals(res.status, 404);
});

Deno.test('endpoints: CS lookups — remote user and alias 404 with NO federation request made', async () => {
  await withFake(async (fake) => {
    const userTarget = '/_matrix/client/v3/profile/@bob:else.test';
    const res1 = await matrix(new Request('http://x' + userTarget));
    assertEquals(res1.status, 404);
    const aliasTarget = '/_matrix/client/v3/directory/room/%23bob:else.test';
    const res2 = await matrix(new Request('http://x' + aliasTarget));
    assertEquals(res2.status, 404);
    // the lookup branches must not start outbound federation work
    assertEquals(fake.requests.length, 0);
  });
});

Deno.test('endpoints: CS lookups — a local user still answered', async () => {
  await registerTestUser('fed-ep-local', 'pass');
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/profile/@fed-ep-local:localhost'),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.displayname, 'fed-ep-local');
  await resetUser('fed-ep-local');
});
