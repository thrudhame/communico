// tests/http-contract.test.ts — HTTP contract checks for the pathfinder
// integration. Boots the REAL endpoint trees in
// process via pathfinder() and asserts on the wire shapes:
//   - deep helper throwing HttpError(401, {errcode…}) → verbatim Matrix body
//   - malformed JSON → 400 {"errcode":"M_NOT_JSON"} (10-json middleware)
//   - CORS stamped on 404 / 405 / 500 / thrown HttpError
// No DB needed: every asserted path resolves before any engine query.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

const CORS = 'access-control-allow-origin';

Deno.test('404: subtree _matrix/404.ts fires from a deeper unmatched path + CORS', async () => {
  // Outcome files live at _matrix/ where the URL tree says; the miss
  // anchors on the deepest fact-bearing stand and the
  // walk's dict carries the closest outcome page — no root hoisting.
  const res = await matrix(
    new Request('http://x/_matrix/client/unknown'),
  );
  assertEquals(res.status, 404);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(await res.json(), {
    errcode: 'M_UNRECOGNIZED',
    error: 'Unrecognized request',
  });
});

Deno.test('404 on a miss under v3 without a token: v3 is public ground (auth is placement)', async () => {
  // Auth lives on the protected folders only (account/, rooms/, …), never
  // as a v3-wide guard. A stranger hitting a wrong public address gets the
  // spec's 404 — the _matrix/404.ts anchor reaches through v3/, which has
  // no middleware of its own.
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/nope'),
  );
  assertEquals(res.status, 404);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(await res.json(), {
    errcode: 'M_UNRECOGNIZED',
    error: 'Unrecognized request',
  });
});

Deno.test('miss inside protected ground without a token → 401 (rooms/20-auth.ts runs on the miss)', async () => {
  // The rooms/ placement carries the auth middleware; §6: middleware runs
  // on hits, misses, and wrong-methods alike. `!x:y` is captured by
  // #roomId, the walk stands in rooms/ (fact file present), the miss is
  // answered by the middleware's thrown 401.
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/rooms/!x:y/nope'),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});

Deno.test('public ground untouched: GET /_matrix/client/v3/login without a token → 200 flows', async () => {
  const res = await matrix(new Request('http://x/_matrix/client/v3/login'));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { flows: [{ type: 'm.login.password' }] });
});

Deno.test('no auth opt-outs remain: `auth = false` is gone from the tree', async () => {
  // The opt-out concept is deleted — auth is placement. This is a test,
  // not just a check: walk the endpoint trees and prove it.
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

Deno.test('405: Matrix shape + Allow header + CORS', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/versions', { method: 'POST' }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(res.headers.get('allow'), 'GET');
  assertEquals(
    (await res.json()).errcode,
    'M_UNRECOGNIZED',
  );
});

Deno.test('405 with a request body: body-sniffing middleware must not 500 the miss', async () => {
  // Wire requests can carry a body where a constructed Request has none —
  // the miss dispatch never enables middleware body access, so 10-json
  // must skip misses (context.miss) instead of parsing.
  const res = await matrix(
    new Request('http://x/_matrix/client/versions', {
      method: 'POST',
      body: '{}',
    }),
  );
  assertEquals(res.status, 405);
  assertEquals((await res.json()).errcode, 'M_UNRECOGNIZED');
});

Deno.test('405 with body under v3: 10-json parses, the 405 outcome renders — never a 500', async () => {
  // A wrong-method request with a body passes through 10-json (body
  // access honored on miss dispatches) and, login/ being public
  // ground, reaches the 405 outcome page with its Allow header.
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

Deno.test('unknown token on protected ground → 401 M_UNKNOWN_TOKEN (lookupToken ran)', async () => {
  // A well-formed but unrecognized bearer gets the deeper 401 — the
  // placement middleware reached the engine and the tenant answered.
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/rooms/!x:y/nope', {
      headers: { authorization: 'Bearer not-a-real-token' },
    }),
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).errcode, 'M_UNKNOWN_TOKEN');
});

Deno.test('CORS preflight short-circuits before auth (204 + full header set)', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/sync', {
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
});

Deno.test('empty body on POST is not M_NOT_JSON (Complement /logout sends Content-Length: 0)', async () => {
  // A zero-length body arrives as a non-null stream on the wire. 10-json
  // must skip it; the request reaches 20-auth, which throws the 401.
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/logout', {
      method: 'POST',
      body: new Uint8Array(0),
    }),
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});

Deno.test('malformed JSON → 400 M_NOT_JSON + CORS (10-json middleware)', async () => {
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

Deno.test('deep helper throws HttpError → verbatim Matrix body + CORS', async () => {
  // whoami with no token: authorize() (deep helper) throws
  // MatrixError(401, M_MISSING_TOKEN) — no envelope, no 500.
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/account/whoami'),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});

Deno.test('deep helper MatrixError from route logic → verbatim body', async () => {
  const res = await matrix(
    new Request(
      'http://x/_matrix/client/v3/register/available?username=al%20ice',
    ),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).errcode, 'M_INVALID_USERNAME');
});

Deno.test('500: uncaught error → M_UNKNOWN + CORS (outcome cascade)', async () => {
  const app = await pathfinder({ roots: ['tests/fixtures/http-contract/'] });
  const res = await app(new Request('http://x/'));
  assertEquals(res.status, 500);
  assertEquals(res.headers.get(CORS), '*');
  assertEquals(await res.json(), {
    errcode: 'M_UNKNOWN',
    error: 'Internal server error',
  });
});

Deno.test('tagline at / (text/plain)', async () => {
  const res = await matrix(new Request('http://x/'));
  assertEquals(res.status, 200);
  assert(res.headers.get('content-type')?.startsWith('text/plain'));
  assert((await res.text()).startsWith('Communico'));
});
