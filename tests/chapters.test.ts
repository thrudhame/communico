// tests/chapters.test.ts — M5b commit 1: the book's local lifecycle
// (§3.6a/§3.6b). A sole member leaving closes the stay (current_chapter
// = NULL; the room stays readable — rooms.leave in /sync, left-room
// /messages); a re-join opens a NEW chapter pair with the snapshot as
// its root commit and the join on top; the old chapter and its x*
// branches stay intact but inert. Live doltgres, HTTP-level via the
// real endpoint trees + direct DB assertions for the branch topology.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { withDb } from '#engine/db.ts';
import { extremities, lookupRoom } from '#engine/room.ts';
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

const LEAVE_FILTER = encodeURIComponent(
  JSON.stringify({ room: { include_leave: true } }),
);

async function branchesOf(dbName: string): Promise<string[]> {
  return await withDb(dbName, async (c) => {
    const r = await c.query('SELECT name FROM dolt.branches ORDER BY name;');
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.name));
  });
}

async function hashOf(dbName: string, branch: string): Promise<string> {
  return await withDb(dbName, async (c) => {
    const r = await c.query(`SELECT HASHOF('${branch}') AS h;`);
    return String(r.rows[0].h);
  });
}

Deno.test('chapters: sole member leaves -> archived read -> re-join opens a new pair, old chapter intact', async () => {
  const alice = await registerTestUser('ch-a', 'pw-ch-a');
  const aTok = alice.access_token!;

  // a PUBLIC room so the leaver can re-join without an invite
  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: { visibility: 'public' },
  })).body.room_id as string;
  const send = (txn: string, body: string) =>
    call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/${txn}`,
      { method: 'PUT', token: aTok, body: { msgtype: 'm.text', body } },
    );
  assertEquals((await send('ch-1', 'first')).status, 200);
  assertEquals((await send('ch-2', 'second')).status, 200);

  const room = (await lookupRoom(roomId))!;
  assertEquals(room.currentChapter, 'chapter1');
  const xBefore = (await extremities(room.dbName, roomId)).map((e) => e.branch);
  assertEquals(xBefore.length, 1, 'one live extremity while joined');

  // the sole member leaves -> the stay closes
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      {
        method: 'POST',
        token: aTok,
        body: {},
      },
    )).status,
    200,
  );
  const archived = (await lookupRoom(roomId))!;
  assertEquals(archived.currentChapter, null, 'closing = clearing the pointer');
  assertEquals(
    (await extremities(room.dbName, roomId)).length,
    0,
    'an archived room has no live extremities',
  );
  // the stay's tip at close — the leave's publish is its last commit
  const tipAtClose = await hashOf(room.dbName, 'chapter1');
  // the old era's extremities after the close: the leave's own x* branch
  // (its prevs were consumed by the ordinary accepted-event rule)
  const xAtClose = (await extremities(room.dbName, roomId, 'chapter1')).map((
    e,
  ) => e.branch);

  // archived read 1: rooms.leave in an include_leave sync
  const syncRes = await call(
    `/_matrix/client/v3/sync?timeout=0&filter=${LEAVE_FILTER}`,
    { token: aTok },
  );
  assertEquals(syncRes.status, 200);
  const leaveRooms =
    ((syncRes.body.rooms as Json)?.leave as Json | undefined) ?? {};
  assert(
    roomId in leaveRooms,
    `rooms.leave holds the archived room: ${
      JSON.stringify(Object.keys(leaveRooms))
    }`,
  );

  // archived read 2: left-room /messages still pages the stay
  const msgs = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=10`,
    { token: aTok },
  );
  assertEquals(msgs.status, 200);
  const bodies = ((msgs.body.chunk as Json[]) ?? [])
    .map((e) => (e.content as Json | undefined)?.body)
    .filter((b) => b !== undefined);
  assert(
    bodies.includes('second'),
    `left-room /messages: ${JSON.stringify(bodies)}`,
  );
  assert(
    bodies.includes('first'),
    `left-room /messages: ${JSON.stringify(bodies)}`,
  );

  // re-join -> a NEW chapter pair; the old chapter intact but inert
  const rejoin = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { method: 'POST', token: aTok, body: {} },
  );
  assertEquals(rejoin.status, 200);
  const reopened = (await lookupRoom(roomId))!;
  assertEquals(reopened.currentChapter, 'chapter3', 'the second stay');
  const branches = await branchesOf(room.dbName);
  for (const b of ['chapter0', 'chapter1', 'chapter2', 'chapter3']) {
    assert(branches.includes(b), `branch ${b}: ${JSON.stringify(branches)}`);
  }
  assertEquals(
    await hashOf(room.dbName, 'chapter1'),
    tipAtClose,
    'the old stay is intact',
  );
  const oldX = (await extremities(room.dbName, roomId, 'chapter1')).map((e) =>
    e.branch
  );
  assertEquals(
    oldX,
    xAtClose,
    'the old era’s extremity set is unchanged by the re-join',
  );
  for (const b of xAtClose) {
    assert(
      branches.includes(b),
      `old-era x* branch ${b} survives (inert, never deleted): ${
        JSON.stringify(branches)
      }`,
    );
  }
  const liveX = await extremities(room.dbName, roomId);
  assertEquals(liveX.length, 1, 'the re-join is the stay’s only extremity');
  assert(!xBefore.includes(liveX[0].branch) || liveX[0].branch !== xBefore[0]);

  // the room is live again: the re-join renders in /sync and /messages
  const after = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=1`,
    { token: aTok },
  );
  assertEquals(after.status, 200);
  const first = ((after.body.chunk as Json[]) ?? [])[0];
  assertEquals(
    first?.type,
    'm.room.member',
    `latest event is the re-join: ${JSON.stringify(first?.type)}`,
  );
  assertEquals(
    (first?.content as Json | undefined)?.membership,
    'join',
  );

  // and traffic flows on the new stay
  assertEquals((await send('ch-3', 'back again')).status, 200);
  const tail = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=1`,
    { token: aTok },
  );
  assertEquals(
    (((tail.body.chunk as Json[]) ?? [])[0]?.content as Json | undefined)?.body,
    'back again',
  );
});
