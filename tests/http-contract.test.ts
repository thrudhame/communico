// tests/http-contract.test.ts — HTTP contract checks for the pathfinder
// integration. Boots the REAL endpoint trees in
// process via pathfinder() and asserts on the wire shapes:
//   - deep helper throwing HttpError(401, {errcode…}) → verbatim Matrix body
//   - malformed JSON → 400 {"errcode":"M_NOT_JSON"} (10-json middleware)
//   - CORS stamped on 404 / 405 / 500 / thrown HttpError
//   - 0.2.2 outcome pages: thrown-error bodies survive; invalid UTF-8 →
//     M_NOT_JSON (fatal decode over body.bytes())
// Mostly DB-free: every asserted path resolves before any engine query,
// except the two thrown-body cases (plan pathfinder-0.2.2 §2 #7), which
// register a user against live doltgres to get a real token.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
import { registerTestUser } from './util.ts';

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

Deno.test('M4: trailing-slash state key routes — /state/:type/ and /state/:type reach the #type handlers', async () => {
  // The empty state key arrives as the trailing-slash form; pathfinder
  // tolerates exactly one trailing slash at leaf acceptance, so both
  // forms land on the #type route. A 401 (auth placement ran) proves the
  // route exists — a 404 would mean no route.
  for (const method of ['GET', 'PUT']) {
    for (
      const path of [
        '/_matrix/client/v3/rooms/!x:y/state/m.room.name/',
        '/_matrix/client/v3/rooms/!x:y/state/m.room.name',
      ]
    ) {
      const res = await matrix(
        new Request('http://x' + path, {
          method,
          ...(method === 'PUT' ? { body: '{}' } : {}),
        }),
      );
      assertEquals(res.status, 401, `${method} ${path} did not route`);
    }
  }
  // and the explicit-key form routes too
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/rooms/!x:y/state/m.room.name/sk'),
  );
  assertEquals(res.status, 401);
});

Deno.test('M4: r0 re-exports answer — /r0/rooms/:id/messages and /joined_members route with auth', async () => {
  // The r0 files re-export the v3 handlers; the r0/20-auth.ts placement
  // protects them. 401 (auth ran) proves the route exists.
  for (
    const path of [
      '/_matrix/client/r0/rooms/!x:y/messages',
      '/_matrix/client/r0/rooms/!x:y/joined_members',
    ]
  ) {
    const res = await matrix(new Request('http://x' + path));
    assertEquals(res.status, 401, `${path} did not route`);
  }
});

Deno.test('profile of a foreign-server user → 404 M_NOT_FOUND before any DB query', async () => {
  // Plan §3.8: the server-part check precedes getProfile, so this stays
  // DB-free like the rest of this file. The thrown 404 renders through
  // _matrix/404.ts as M_NOT_FOUND (misses remain M_UNRECOGNIZED).
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/profile/@nobody:x'),
  );
  assertEquals(res.status, 404);
  assertEquals((await res.json()).errcode, 'M_NOT_FOUND');
});

Deno.test('A8: invalid UTF-8 in a JSON body → 400 M_NOT_JSON (fatal decode over body.bytes())', async () => {
  // Complement apidoc_request_encoding_test.go:20-28: the raw bytes
  // { "test":"a\x81" } — 0x81 is invalid UTF-8. text() would decode it
  // non-fatally (U+FFFD) and JSON.parse would then succeed; 10-json's
  // fatal TextDecoder catches it before any handler runs.
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

Deno.test('thrown 404 keeps its own body through the page; a miss stays M_UNRECOGNIZED', async () => {
  // 0.2.2: context.error carries the thrown HttpError into the outcome
  // page — the page renders the THROWN body (errcode AND message), not a
  // fixed fallback. A routing miss (no thrown error) keeps the page text.
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

Deno.test('thrown 413 keeps M_TOO_LARGE through the page (not the fixed fallback)', async () => {
  const dir = await Deno.makeTempDir();
  const prevRoot = Deno.env.get('MEDIA_ROOT');
  const prevMax = Deno.env.get('MEDIA_MAX_BYTES');
  Deno.env.set('MEDIA_ROOT', dir);
  Deno.env.set('MEDIA_MAX_BYTES', '8');
  try {
    const u = await registerTestUser('hc413', 'pw-hc413');
    const res = await matrix(
      new Request('http://x/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${u.access_token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(9) as BodyInit,
      }),
    );
    assertEquals(res.status, 413);
    assertEquals(await res.json(), {
      errcode: 'M_TOO_LARGE',
      error: 'Upload exceeds the server limit',
    });
  } finally {
    if (prevRoot === undefined) Deno.env.delete('MEDIA_ROOT');
    else Deno.env.set('MEDIA_ROOT', prevRoot);
    if (prevMax === undefined) Deno.env.delete('MEDIA_MAX_BYTES');
    else Deno.env.set('MEDIA_MAX_BYTES', prevMax);
  }
});

Deno.test('band C auth mix: GET /directory/room and POST /refresh answer without a token; PUT /directory/room 401s', async () => {
  const u = await registerTestUser('hc-mix', 'pw-hc-mix');
  // an alias to resolve: createRoom with room_alias_name
  const create = await matrix(
    new Request('http://x/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ room_alias_name: 'hc-mix' }),
    }),
  );
  assertEquals(create.status, 200);

  // GET /directory/room/<alias> is PUBLIC (directory.yaml:88-159, no
  // security block) — answers with no Authorization header
  const alias = encodeURIComponent(`#hc-mix:${serverName()}`);
  const resolve = await matrix(
    new Request(`http://x/_matrix/client/v3/directory/room/${alias}`),
  );
  assertEquals(resolve.status, 200);
  assert('room_id' in (await resolve.json()));

  // PUT /directory/room/<alias> is protected (file-level authorize()) —
  // 401 without a token
  const alias2 = encodeURIComponent(`#hc-mix-2:${serverName()}`);
  const put = await matrix(
    new Request(`http://x/_matrix/client/v3/directory/room/${alias2}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: `!whatever:${serverName()}` }),
    }),
  );
  assertEquals(put.status, 401);

  // POST /refresh is PUBLIC (refresh.yaml:37-39) — the refresh token IS
  // the authentication; no Authorization header
  const login = await matrix(
    new Request('http://x/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'hc-mix' },
        password: 'pw-hc-mix',
        refresh_token: true,
      }),
    }),
  );
  assertEquals(login.status, 200);
  const loginBody = await login.json();
  assert(typeof loginBody.refresh_token === 'string');
  const refresh = await matrix(
    new Request('http://x/_matrix/client/v3/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: loginBody.refresh_token }),
    }),
  );
  assertEquals(refresh.status, 200);
  const rotated = await refresh.json();
  assert(typeof rotated.access_token === 'string');
  assert(typeof rotated.refresh_token === 'string');
});

Deno.test('POST /search without a token → 401', async () => {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/search', { method: 'POST' }),
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).errcode, 'M_MISSING_TOKEN');
});
