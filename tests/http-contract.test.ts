// Account/middleware assertions from doltgres:tests/http-contract.test.ts.
// Room, media, key and federation route assertions return in their stages;
// see the external app-account notes for the assertion-level mapping.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { httpSuite } from '#tests/http-app.ts';

const { matrix, registerTestUser, test } = httpSuite('HTTP contract');
const CORS = 'access-control-allow-origin';

test('404: subtree _matrix/404.ts fires from a deeper unmatched path + CORS', async () => {
  const res = await matrix(new Request('http://x/_matrix/client/unknown'));
  assertEquals(res.status, 404);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(await res.json(), {
    errcode: 'M_UNRECOGNIZED',
    error: 'Unrecognized request',
  });
});

test('404 on a miss under v3 without a token: v3 is public ground (auth is placement)', async () => {
  const res = await matrix(new Request('http://x/_matrix/client/v3/nope'));
  assertEquals(res.status, 404);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(await res.json(), {
    errcode: 'M_UNRECOGNIZED',
    error: 'Unrecognized request',
  });
});

test('miss inside protected ground without a token → 401 (account/20-auth.ts runs on the miss)', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/account/nope'),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});

test('public ground untouched: GET /_matrix/client/v3/login without a token → 200 flows', async () => {
  const res = await matrix(new Request('http://x/_matrix/client/v3/login'));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { flows: [{ type: 'm.login.password' }] });
});

test('no auth opt-outs remain: `auth = false` is gone from the tree', async () => {
  const endings: string[] = [];
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith('.ts')) endings.push(p);
    }
  }
  await walk('api/endpoints');
  for (const file of endings) {
    const text = await Deno.readTextFile(file);
    assert(
      !text.includes('auth = false') && !text.includes('context.meta.auth'),
      `${file} still carries an auth opt-out`,
    );
  }
});

test('405: Matrix shape + Allow header + CORS', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/versions', { method: 'POST' }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(res.headers.get('allow'), 'GET');
  assertEquals((await res.json()).errcode, 'M_UNRECOGNIZED');
});

test('405 with a request body: body-sniffing middleware must not 500 the miss', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/versions', {
      method: 'POST',
      body: '{}',
    }),
  );
  assertEquals(res.status, 405);
  assertEquals((await res.json()).errcode, 'M_UNRECOGNIZED');
});

test('405 with body under v3: 10-json parses, the 405 outcome renders — never a 500', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/login', {
      method: 'PUT',
      body: '{}',
    }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get('allow'), 'GET, POST');
  assertEquals((await res.json()).errcode, 'M_UNRECOGNIZED');
});

test('unknown token on protected ground → 401 M_UNKNOWN_TOKEN (lookupToken ran)', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/account/nope', {
      headers: { authorization: 'Bearer not-a-real-token' },
    }),
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).errcode, 'M_UNKNOWN_TOKEN');
});

test('CORS preflight short-circuits before auth (204 + full header set)', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/account/whoami', {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'GET' },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(
    res.headers.get('access-control-allow-methods'),
    'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  );
  assertEquals(
    res.headers.get('access-control-allow-headers'),
    'Authorization, Content-Type',
  );
  await res.arrayBuffer();
});

test('empty body on POST is not M_NOT_JSON (Complement /logout sends Content-Length: 0)', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/logout', {
      method: 'POST',
      body: new Uint8Array(0),
    }),
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});

test('malformed JSON → 400 M_NOT_JSON + CORS (10-json middleware)', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/register', {
      method: 'POST',
      body: '{bad',
    }),
  );
  assertEquals(res.status, 400);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals((await res.json()).errcode, 'M_NOT_JSON');
});

test('deep helper throws HttpError → verbatim Matrix body + CORS', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/account/whoami'),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});

test('deep helper MatrixError from route logic → verbatim body', async () => {
  const res = await matrix(
    new Request(
      'http://x/_matrix/client/v3/register/available?username=al%20ice',
    ),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).errcode, 'M_INVALID_USERNAME');
});

test('500: uncaught error → M_UNKNOWN + CORS (outcome cascade)', async () => {
  const app = await pathfinder({ roots: ['tests/fixtures/http-contract/'] });
  const res = await app(new Request('http://x/'));
  assertEquals(res.status, 500);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(await res.json(), {
    errcode: 'M_UNKNOWN',
    error: 'Internal server error',
  });
});

test('tagline at / (text/plain)', async () => {
  const res = await matrix(new Request('http://x/'));
  assertEquals(res.status, 200);
  assert(res.headers.get('content-type')?.startsWith('text/plain'));
  assert((await res.text()).startsWith('Communico'));
});

test('A8: invalid UTF-8 in a JSON body → 400 M_NOT_JSON (fatal decode over body.bytes())', async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{ "test":"a'),
    0x81,
    ...new TextEncoder().encode('" }'),
  ]);
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bytes as BodyInit,
    }),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).errcode, 'M_NOT_JSON');
});

test('thrown 404 keeps its own body through the page; a miss stays M_UNRECOGNIZED', async () => {
  const u = await registerTestUser('hc404', 'pw-hc404');
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/devices/unknown_device', {
      headers: { Authorization: `Bearer ${u.access_token}` },
    }),
  );
  assertEquals(res.status, 404);
  assertEquals(await res.json(), {
    errcode: 'M_NOT_FOUND',
    error: 'unknown device',
  });
  const miss = await matrix(new Request('http://x/_matrix/client/v3/nope'));
  assertEquals(miss.status, 404);
  assertEquals((await miss.json()).errcode, 'M_UNRECOGNIZED');
});

// The JSON middleware's non-object contract from body-validation.test.ts,
// exercised on register while /send and /state wait for 5a-2.
test('body validation: valid JSON non-object → 400 M_BAD_JSON', async () => {
  for (const raw of ['"aGVsbG8="', '42', '[1,2]', 'true', 'null']) {
    const res = await matrix(
      new Request('http://x/_matrix/client/v3/register', {
        method: 'POST',
        body: raw,
      }),
    );
    assertEquals(res.status, 400, `raw ${raw}`);
    assertEquals((await res.json()).errcode, 'M_BAD_JSON', `raw ${raw}`);
  }
});
