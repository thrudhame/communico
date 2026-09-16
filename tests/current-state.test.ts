// tests/current-state.test.ts — the room's current resolved state lives on
// `main` (plan current-state-on-main §1): ingest publishes it, a
// soft-failed event never moves it, re-resolution keeps it, and no x*
// branch tip ever drifts from its event's commit (D8). Live doltgres.
import { assert, assertEquals } from '@std/assert';
import { createRoom, headExtremity, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { ident, serverDb, withDb } from '#engine/db.ts';
import { stateNow } from '#engine/timeline.ts';
import { reresolveFromDag } from '#engine/adopt.ts';
import { latestExtremityEventId, resetRoom } from '#tests/util.ts';

const ROOM = '!current-state:localhost';

Deno.test('current state on main: publish, soft-fail stillness, D8 after re-resolve', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  // membership via the engine pipeline: alice (creator) invites bob, bob
  // joins (same shape as soft-fail.test.ts)
  const inviteBase = await latestExtremityEventId(ROOM);
  await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.member',
      state_key: '@bob:localhost',
      sender: '@dev:localhost',
      content: { membership: 'invite' },
      prev_events: [inviteBase],
      origin_server_ts: 1000,
    }),
  );
  const joinBase = await latestExtremityEventId(ROOM);
  await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.member',
      state_key: '@bob:localhost',
      sender: '@bob:localhost',
      content: { membership: 'join' },
      prev_events: [joinBase],
      origin_server_ts: 1001,
    }),
  );

  // fork point: the tip both branches will cite
  const base = await latestExtremityEventId(ROOM);
  const room = (await lookupRoom(ROOM))!;
  const mainHash = async (): Promise<string> =>
    await withDb(room.dbName, async (c) => {
      const r = await c.query(`SELECT (SELECT HASHOF('main')) AS h;`);
      return String(r.rows[0].h);
    });

  // branch A: alice bans bob — ingest must publish the resolved state
  const beforeBan = await mainHash();
  const ban = await author(ROOM, {
    type: 'm.room.member',
    state_key: '@bob:localhost',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    prev_events: [base],
    origin_server_ts: 2000,
  });
  await ingestEvent(ROOM, ban, { keepPrevBranches: true });
  const afterBan = await mainHash();

  // (2a) main moved across the ban ingest
  assert(beforeBan !== afterBan, 'HASHOF(main) must change across the ban');

  // (1) stateNow shows the ban WITHOUT re-resolution — ingest published it
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow(room.dbName)) as any[];
  const bobRow = st.find((r) => r.state_key === '@bob:localhost');
  assertEquals(bobRow?.content?.membership, 'ban');

  // branch B: bob's message citing the pre-ban tip — soft-fails; its prev
  // branch is kept, so the extremity set truly does not change
  const msg = await author(ROOM, {
    type: 'm.room.message',
    sender: '@bob:localhost',
    content: { body: 'ban evasion attempt', msgtype: 'm.text' },
    prev_events: [base],
    origin_server_ts: 2001,
  });
  await ingestEvent(ROOM, msg, { keepPrevBranches: true });
  const afterMsg = await mainHash();

  // (2b) main did NOT move across the soft-failed message
  assertEquals(afterMsg, afterBan, 'a soft-failed event must not move main');

  // (3) the oracle: re-resolution leaves stateNow unchanged, and every x*
  // branch tip still equals its event's commit (D8 after re-resolve)
  await reresolveFromDag(ROOM);
  // deno-lint-ignore no-explicit-any
  const resolved = (await stateNow(room.dbName)) as any[];
  const resolvedBob = resolved.find((r) => r.state_key === '@bob:localhost');
  assertEquals(resolvedBob?.content?.membership, 'ban');
  await withDb(room.dbName, async (c) => {
    const b = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%';`,
    );
    // deno-lint-ignore no-explicit-any
    for (const row of b.rows as any[]) {
      const branch = String(row.name);
      const h = await c.query(
        `SELECT (SELECT HASHOF('${ident(branch)}')) AS h;`,
      );
      const idx = await withDb(serverDb(), async (s) => {
        return await s.query(
          'SELECT commit_hash FROM event_index WHERE room_id = $1 AND branch_name = $2;',
          [ROOM, branch],
        );
      });
      assertEquals(
        String(h.rows[0].h),
        String(idx.rows[0].commit_hash),
        `D8 broken on ${branch}`,
      );
    }
  });

  // (4) headExtremity returns the ban (deepest live tip; the soft-failed
  // message is not an extremity at all)
  const head = await headExtremity(room.dbName, ROOM);
  assertEquals(head?.eventId, ban.event_id);
});
