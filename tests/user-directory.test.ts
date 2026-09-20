// tests/user-directory.test.ts — band C item 5 (D6): the five
// Complement assertions (user_directory_display_names_test.go) — public
// profile names visible by room visibility/sharing, room-specific names
// never searched, results carry the GLOBAL profile. Live doltgres,
// HTTP-level via the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

const search = (tok: string, term: string, limit?: number) =>
  call('/_matrix/client/v3/user_directory/search', {
    method: 'POST',
    token: tok,
    body: limit === undefined
      ? { search_term: term }
      : { search_term: term, limit },
  });

Deno.test('user directory: visible users only, global names only, self excluded', async () => {
  const alice = await registerTestUser('ud-alice', 'pw-ud-alice');
  const bob = await registerTestUser('ud-bob', 'pw-ud-bob');
  const eve = await registerTestUser('ud-eve', 'pw-ud-eve');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const eTok = eve.access_token!;
  const aId = alice.user_id as string;

  // alice's public profile name; a public room makes her visible to eve
  assertEquals(
    (await call(
      `/_matrix/client/v3/profile/${encodeURIComponent(aId)}/displayname`,
      { method: 'PUT', token: aTok, body: { displayname: 'Alice Cooper' } },
    )).status,
    200,
  );
  const publicRoom = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: { visibility: 'public' },
  })).body.room_id as string;

  // eve finds alice by profile display name and by mxid substring
  for (const term of ['Alice Cooper', 'ud-alice']) {
    const res = await search(eTok, term);
    const results = res.body.results as Json[];
    assertEquals(results.length, 1, term);
    assertEquals(results[0].user_id, aId);
    assertEquals(results[0].display_name, 'Alice Cooper');
    assertEquals(res.body.limited, false);
  }

  // bob shares a private room with alice, in which she reveals the
  // room-specific name "Freddy" — never searchable, never returned
  const privateRoom = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: bTok,
    body: { invite: [aId] },
  })).body.room_id as string;
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(privateRoom)}/join`,
      { method: 'POST', token: aTok, body: {} },
    )).status,
    200,
  );
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(privateRoom)
      }/state/m.room.member/${encodeURIComponent(aId)}`,
      {
        method: 'PUT',
        token: aTok,
        body: { displayname: 'Freddy', membership: 'join' },
      },
    )).status,
    200,
  );
  assertEquals(
    ((await search(eTok, 'Freddy')).body.results as Json[]).length,
    0,
    'room-specific name must not be searchable',
  );
  // bob still finds her by the GLOBAL name and gets the global profile
  const bRes = await search(bTok, 'alice co');
  const bResults = bRes.body.results as Json[];
  assertEquals(bResults.length, 1);
  assertEquals(bResults[0].display_name, 'Alice Cooper');

  // the searcher is excluded from their own results
  const selfRes = await search(aTok, 'ud-');
  assert(
    !(selfRes.body.results as Json[]).some((r) => r.user_id === aId),
    'self excluded',
  );

  // limit cuts and flags (3g): eve joins alice's public room, so from
  // alice "ud-" matches bob (shared private) and eve (public)
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(publicRoom)}/join`,
      { method: 'POST', token: eTok, body: {} },
    )).status,
    200,
  );
  const lim = await search(aTok, 'ud-', 1);
  assertEquals((lim.body.results as Json[]).length, 1);
  assertEquals(lim.body.limited, true);

  // search_term is required
  const bad = await call('/_matrix/client/v3/user_directory/search', {
    method: 'POST',
    token: bTok,
    body: {},
  });
  assertEquals(bad.status, 400);
});
