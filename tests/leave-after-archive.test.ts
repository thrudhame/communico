// tests/leave-after-archive.test.ts — §3.4 of the fix pass: an invited
// local user can reject after the last joined member left (the stay is
// closed): the leave lands on the newest stay's tips, does not reopen
// (current_chapter stays NULL), and /sync shows rooms.leave.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { lookupRoom } from '#engine/room.ts';
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

async function currentChapterOf(roomId: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT current_chapter FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    return r.rows.length === 0 || r.rows[0].current_chapter == null
      ? null
      : String(r.rows[0].current_chapter);
  });
}

Deno.test('an invited local user rejects after the stay closed: 200, rooms.leave in sync, current_chapter stays NULL', async () => {
  const alice = await registerTestUser('la-a', 'pw-la-a');
  const bob = await registerTestUser('la-b', 'pw-la-b');
  const A = alice.access_token!;
  const B = bob.access_token!;

  const create = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: A,
    body: { preset: 'private_chat' },
  });
  assertEquals(create.status, 200);
  const roomId = String(create.body.room_id);

  const invite = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    { method: 'POST', token: A, body: { user_id: bob.user_id } },
  );
  assertEquals(invite.status, 200);

  const sync0 = await call('/_matrix/client/v3/sync?timeout=0', { token: B });
  const since = String(sync0.body.next_batch);

  // alice (the sole joined member) leaves — the stay closes
  const aliceLeave = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
    { method: 'POST', token: A, body: {} },
  );
  assertEquals(aliceLeave.status, 200);
  assertEquals(await currentChapterOf(roomId), null, 'stay closed');

  // bob, invited and local, rejects — must not 500
  const bobLeave = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
    { method: 'POST', token: B, body: {} },
  );
  assertEquals(bobLeave.status, 200, JSON.stringify(bobLeave.body));

  // the stay stays closed
  assertEquals(await currentChapterOf(roomId), null, 'no reopen');

  // bob's incremental sync: rooms.leave carries the room, rooms.invite doesn't
  const sync1 = await call(
    `/_matrix/client/v3/sync?timeout=0&since=${encodeURIComponent(since)}`,
    { token: B },
  );
  assertEquals(sync1.status, 200);
  const rooms = sync1.body.rooms as Json;
  assert(
    (rooms.leave as Json)[roomId] !== undefined,
    `rooms.leave has the room: ${JSON.stringify(rooms.leave)}`,
  );
  assertEquals((rooms.invite as Json)[roomId], undefined);

  // the room's x* tips: exactly the new leave's branch
  const room = await lookupRoom(roomId);
  assert(room !== null);
  const tips = await withDb(room.dbName, async (c) => {
    const r = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%';`,
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.name));
  });
  const memRow = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT event_id FROM room_membership WHERE room_id = $1 AND user_id = $2;',
      [roomId, bob.user_id],
    );
    return r.rows.length === 0 ? null : String(r.rows[0].event_id);
  });
  assert(memRow !== null, 'bob has a membership row');
  const tipOfLeave = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT branch_name FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, memRow],
    );
    return r.rows.length === 0 || r.rows[0].branch_name == null
      ? null
      : String(r.rows[0].branch_name);
  });
  assert(tipOfLeave !== null, 'the leave has a branch');
  assertEquals(tips, [tipOfLeave]);
});
