// tests/profile.test.ts — band C item 4 (D5): a profile change fans out
// as an m.room.member join event in every room the user is joined to
// (spec v1.16 client-server-api _index.md:3773-3795). avatar_url is
// accepted verbatim (Complement sends a non-mxc string). Live doltgres,
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

const sync = (token: string, query = '') =>
  call(`/_matrix/client/v3/sync?timeout=0${query}`, { token });

Deno.test('profile: displayname and avatar_url changes propagate to member events (verbatim avatar)', async () => {
  const alice = await registerTestUser('pf-a', 'pw-pf-a');
  const bob = await registerTestUser('pf-b', 'pw-pf-b');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: { invite: [bob.user_id as string] },
  })).body.room_id as string;
  assertEquals(
    (await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      token: bTok,
      body: {},
    })).status,
    200,
  );
  const bSince = (await sync(bTok)).body.next_batch as string;

  // displayname change → member event with the new displayname
  assertEquals(
    (await call(
      `/_matrix/client/v3/profile/${
        encodeURIComponent(alice.user_id as string)
      }/displayname`,
      { method: 'PUT', token: aTok, body: { displayname: 'LemurLover' } },
    )).status,
    200,
  );
  let res = await sync(bTok, `&since=${encodeURIComponent(bSince)}`);
  let bNext = res.body.next_batch as string;
  let timeline = ((((res.body.rooms as Json).join as Json)[roomId] as Json)
    ?.timeline as Json)?.events as Json[];
  let member = timeline.find((e) =>
    e.type === 'm.room.member' && e.state_key === alice.user_id
  );
  assert(member !== undefined, 'member event for the displayname change');
  assertEquals((member!.content as Json).displayname, 'LemurLover');

  // avatar_url change, verbatim non-mxc string → member event carries it
  assertEquals(
    (await call(
      `/_matrix/client/v3/profile/${
        encodeURIComponent(alice.user_id as string)
      }/avatar_url`,
      { method: 'PUT', token: aTok, body: { avatar_url: 'LemurLover' } },
    )).status,
    200,
  );
  res = await sync(bTok, `&since=${encodeURIComponent(bNext)}`);
  bNext = res.body.next_batch as string;
  timeline = ((((res.body.rooms as Json).join as Json)[roomId] as Json)
    ?.timeline as Json)?.events as Json[];
  member = timeline.find((e) =>
    e.type === 'm.room.member' && e.state_key === alice.user_id
  );
  assert(member !== undefined, 'member event for the avatar change');
  assertEquals((member!.content as Json).avatar_url, 'LemurLover');

  // the global profile reflects both
  const profile = await call(
    `/_matrix/client/v3/profile/${encodeURIComponent(alice.user_id as string)}`,
    { token: bTok },
  );
  assertEquals(profile.body.displayname, 'LemurLover');
  assertEquals(profile.body.avatar_url, 'LemurLover');
});
