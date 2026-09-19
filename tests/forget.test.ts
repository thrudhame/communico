// tests/forget.test.ts — band C item 2: the TestRoomForget contract rows
// (plan §2/D4; spec v1.16 leaving.yaml:80-126). Forgotten rooms leave
// initial/full_state sync entirely, 403 on history reads, but an
// in-window leave event still comes down an incremental sync. Live
// doltgres, HTTP-level via the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
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

const sync = (token: string, query = '') =>
  call(`/_matrix/client/v3/sync?timeout=0${query}`, { token });

const LEAVE_FILTER = encodeURIComponent(
  JSON.stringify({ room: { include_leave: true } }),
);

Deno.test('forget: joined 400; forgotten hidden from initial sync + /messages; leave still incremental; re-join clears', async () => {
  const alice = await registerTestUser('fg-a', 'pw-fg-a');
  const bob = await registerTestUser('fg-b', 'pw-fg-b');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const SN = serverName();

  const mkRoom = async () => {
    const res = await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: aTok,
      body: { invite: [`@fg-b:${SN}`] },
    });
    return res.body.room_id as string;
  };
  const bobJoin = async (roomId: string) => {
    assertEquals(
      (await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: bTok,
          body: {},
        },
      )).status,
      200,
    );
  };
  const leave = (tok: string, roomId: string) =>
    call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: 'POST',
      token: tok,
      body: {},
    });
  const forget = (tok: string, roomId: string) =>
    call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`, {
      method: 'POST',
      token: tok,
      body: {},
    });

  // 1. can't forget a room you're still in → 400 M_UNKNOWN
  const joined = await mkRoom();
  const jres = await forget(aTok, joined);
  assertEquals(jres.status, 400);
  assertEquals(jres.body.errcode, 'M_UNKNOWN');

  // no membership row at all → 400 M_UNKNOWN (bob is never invited here)
  const unknown = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: {},
  })).body.room_id as string;
  const ures = await forget(bTok, unknown);
  assertEquals(ures.status, 400);
  assertEquals(ures.body.errcode, 'M_UNKNOWN');

  // 2. forgotten room: /messages 403s M_FORBIDDEN with NO query params
  //    (D10 — access before params). Bob stays joined and keeps
  //    posting AFTER the forget — ordinary traffic must not un-forget
  //    the room (the full-state fold preserves the flag; only the
  //    user's own membership events clear it).
  const room2 = await mkRoom();
  await bobJoin(room2);
  assertEquals((await leave(aTok, room2)).status, 200);
  assertEquals((await forget(aTok, room2)).status, 200);
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(room2)
      }/send/m.room.message/fg-after-forget`,
      {
        method: 'PUT',
        token: bTok,
        body: { msgtype: 'm.text', body: 'after' },
      },
    )).status,
    200,
  );
  const mres = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room2)}/messages`,
    { token: aTok },
  );
  assertEquals(mres.status, 403);
  assertEquals(mres.body.errcode, 'M_FORBIDDEN');

  // 3. forgotten room is in NO section of an initial sync, even with
  //    include_leave — even after bob's post-forget traffic
  const initial = await sync(aTok, `&filter=${LEAVE_FILTER}`);
  const rooms = (initial.body.rooms ?? {}) as Json;
  for (const section of ['join', 'invite', 'leave', 'archived']) {
    const s = (rooms[section] ?? {}) as Json;
    assertEquals(
      Object.keys(s).includes(room2),
      false,
      `room in ${section}`,
    );
  }

  // 4. but the leave event DOES show up in an incremental sync covering
  //    it (spec-wording bug noted in the Complement test)
  const room4 = await mkRoom();
  const before = (await sync(aTok)).body.next_batch as string;
  assertEquals((await leave(aTok, room4)).status, 200);
  assertEquals((await forget(aTok, room4)).status, 200);
  const inc = await sync(
    aTok,
    `&since=${encodeURIComponent(before)}&filter=${LEAVE_FILTER}`,
  );
  const left = ((inc.body.rooms as Json).leave ?? {}) as Json;
  assert(room4 in left, 'forgotten room leave event in incremental sync');

  // 5. can forget a room you've been kicked from
  const room5 = await mkRoom();
  await bobJoin(room5);
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(room5)}/kick`,
      {
        method: 'POST',
        token: aTok,
        body: { user_id: `@fg-b:${SN}` },
      },
    )).status,
    200,
  );
  assertEquals((await forget(bTok, room5)).status, 200);

  // 6. re-invite + re-join clears the forgotten flag: the room is back
  //    in initial sync and /messages reads again
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(room5)}/invite`,
      {
        method: 'POST',
        token: aTok,
        body: { user_id: `@fg-b:${SN}` },
      },
    )).status,
    200,
  );
  await bobJoin(room5);
  const back = await sync(bTok, `&filter=${LEAVE_FILTER}`);
  const joinedNow = ((back.body.rooms as Json).join ?? {}) as Json;
  assert(room5 in joinedNow, 're-joined room in initial sync');
  const m2 = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room5)}/messages?dir=b`,
    { token: bTok },
  );
  assertEquals(m2.status, 200);

  // 7. can forget a room we weren't an actual member of (invited, then
  //    left the invite)
  const room7 = await mkRoom();
  assertEquals((await leave(bTok, room7)).status, 200); // decline invite
  assertEquals((await forget(bTok, room7)).status, 200);
});
