// tests/ignored-users.test.ts — band C item 4 (3i): invites from ignored
// users never reach the client (spec v1.16 ignore_users.md:45-46).
// Live doltgres, HTTP-level via the real endpoint trees.
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

Deno.test('ignored users: their invites do not appear in sync, others do', async () => {
  const alice = await registerTestUser('ig-a', 'pw-ig-a');
  const bob = await registerTestUser('ig-b', 'pw-ig-b');
  const carol = await registerTestUser('ig-c', 'pw-ig-c');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const cTok = carol.access_token!;

  // alice ignores bob
  assertEquals(
    (await call(
      `/_matrix/client/v3/user/${
        encodeURIComponent(alice.user_id as string)
      }/account_data/m.ignored_user_list`,
      {
        method: 'PUT',
        token: aTok,
        body: { ignored_users: { [bob.user_id as string]: {} } },
      },
    )).status,
    200,
  );
  const since = (await sync(aTok)).body.next_batch as string;

  // bob and carol each invite alice
  const mkInvited = async (tok: string) => {
    const roomId = (await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: tok,
      body: { invite: [alice.user_id as string] },
    })).body.room_id as string;
    return roomId;
  };
  const bobRoom = await mkInvited(bTok);
  const carolRoom = await mkInvited(cTok);

  const res = await sync(aTok, `&since=${encodeURIComponent(since)}`);
  const invites = ((res.body.rooms as Json)?.invite ?? {}) as Json;
  assert(carolRoom in invites, "carol's invite appears");
  assert(!(bobRoom in invites), "bob's invite is filtered out");
});
