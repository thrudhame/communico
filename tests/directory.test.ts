// tests/directory.test.ts — band C item 1: the public room directory
// (TestPublicRooms + the TestRoomState publicRooms rows; plan §2; spec
// v1.16 list_public_rooms.yaml). Live doltgres, HTTP-level via the real
// endpoint trees.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
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

Deno.test('directory: /publicRooms listing + search, /directory/list get/put, auth mix', async () => {
  const alice = await registerTestUser('dir-a', 'pw-dir-a');
  const bob = await registerTestUser('dir-b', 'pw-dir-b');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const SN = serverName();

  const mk = async (body: unknown): Promise<string> => {
    const res = await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: aTok,
      body,
    });
    return res.body.room_id as string;
  };
  const roomId = await mk({
    visibility: 'public',
    name: 'Test Name',
    topic: 'Test Topic Wombles',
    room_alias_name: 'dir-pub',
  });

  // GET /publicRooms is PUBLIC (no token) and lists the room with the
  // spec chunk fields
  const listed = await call('/_matrix/client/v3/publicRooms');
  assertEquals(listed.status, 200);
  const chunk = (listed.body.chunk as Json[]).find((c) => c.room_id === roomId);
  assertEquals(chunk !== undefined, true);
  assertEquals(chunk!.canonical_alias, `#dir-pub:${SN}`);
  assertEquals(chunk!.name, 'Test Name');
  assertEquals(chunk!.topic, 'Test Topic Wombles');
  assertEquals(chunk!.num_joined_members, 1);
  assertEquals(chunk!.world_readable, false);
  assertEquals(chunk!.guest_can_join, false);
  assertEquals(chunk!.join_rule, 'public');
  assertEquals(typeof listed.body.total_room_count_estimate, 'number');

  // name/topic omitted when unset
  const bare = await mk({ visibility: 'public' });
  const bareChunk = ((await call('/_matrix/client/v3/publicRooms')).body
    .chunk as Json[]).find((c) => c.room_id === bare);
  assertEquals('name' in bareChunk!, false);
  assertEquals('topic' in bareChunk!, false);
  assertEquals('canonical_alias' in bareChunk!, false);

  // POST search (AUTHED) — case-insensitive substring over
  // name/topic/canonical_alias
  const search = await call('/_matrix/client/v3/publicRooms', {
    method: 'POST',
    token: aTok,
    body: { filter: { generic_search_term: 'wombles' } },
  });
  assertEquals(search.status, 200);
  const hits = search.body.chunk as Json[];
  assertEquals(hits.length, 1);
  assertEquals(hits[0].room_id, roomId);
  // search also matches the canonical alias
  const aliasHit = await call('/_matrix/client/v3/publicRooms', {
    method: 'POST',
    token: aTok,
    body: { filter: { generic_search_term: 'DIR-PUB' } },
  });
  assertEquals(
    (aliasHit.body.chunk as Json[]).some((c) => c.room_id === roomId),
    true,
  );

  // POST /publicRooms is authed (spec security block; user ruling
  // 2026-09-19) — 401 without a token
  assertEquals(
    (await call('/_matrix/client/v3/publicRooms', {
      method: 'POST',
      body: {},
    })).status,
    401,
  );

  // /directory/list: GET public; PUT (authed, joined) toggles the listing
  const list = `/_matrix/client/v3/directory/list/room/${
    encodeURIComponent(roomId)
  }`;
  const vis = await call(list);
  assertEquals(vis.status, 200);
  assertEquals(vis.body.visibility, 'public');
  assertEquals(
    (await call(list, {
      method: 'PUT',
      token: aTok,
      body: { visibility: 'private' },
    })).status,
    200,
  );
  assertEquals((await call(list)).body.visibility, 'private');
  assertEquals(
    ((await call('/_matrix/client/v3/publicRooms')).body.chunk as Json[])
      .some((c) => c.room_id === roomId),
    false,
  );
  assertEquals(
    (await call(list, {
      method: 'PUT',
      token: aTok,
      body: { visibility: 'public' },
    })).status,
    200,
  );
  assertEquals(
    ((await call('/_matrix/client/v3/publicRooms')).body.chunk as Json[])
      .some((c) => c.room_id === roomId),
    true,
  );

  // PUT without a token → 401; by a non-member → 403; bad value → 400
  assertEquals(
    (await call(list, {
      method: 'PUT',
      body: { visibility: 'private' },
    })).status,
    401,
  );
  assertEquals(
    (await call(list, {
      method: 'PUT',
      token: bTok,
      body: { visibility: 'private' },
    })).status,
    403,
  );
  assertEquals(
    (await call(list, {
      method: 'PUT',
      token: aTok,
      body: { visibility: 'nope' },
    })).status,
    400,
  );

  // GET on an unknown room → 404 M_NOT_FOUND
  assertEquals(
    (await call(
      `/_matrix/client/v3/directory/list/room/${
        encodeURIComponent('!nope:' + SN)
      }`,
    )).status,
    404,
  );
});
