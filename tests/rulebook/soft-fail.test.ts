// tests/rulebook/soft-fail.test.ts — S8 check 6 (server-server-api.md
// 604-621): an event authorized against the state at its prevs but NOT
// against the current room state is "soft failed" — stored verbatim, NOT
// an extremity for authoring, excluded from the client-visible timeline.
// Live doltgres (needs the engine + a provisioned server DB).
import { assert, assertEquals } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { stateNow } from '#engine/timeline.ts';
import { reresolveFromDag } from '#engine/adopt.ts';
import { latestExtremityEventId, resetRoom } from '#tests/util.ts';

const ROOM = '!softfail:localhost';

Deno.test("soft-fail: a banned user's concurrent message soft-fails", async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });
  // membership via the engine pipeline (CS invite/join endpoints are M4):
  // alice (creator) invites bob, bob joins
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

  // branch A: alice bans bob (a power event — applies on the resolved
  // current state)
  const ban = await author(ROOM, {
    type: 'm.room.member',
    state_key: '@bob:localhost',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    prev_events: [base],
    origin_server_ts: 2000,
  });
  await ingestEvent(ROOM, ban, { keepPrevBranches: true });

  // branch B: bob sends a message citing the PRE-BAN tip — perfectly valid
  // against the state at its prevs (he was still joined there)
  const msg = await author(ROOM, {
    type: 'm.room.message',
    sender: '@bob:localhost',
    content: { body: 'ban evasion attempt', msgtype: 'm.text' },
    prev_events: [base],
    origin_server_ts: 2001,
  });
  await ingestEvent(ROOM, msg); // soft-fail does NOT surface as an error

  // stored verbatim, flagged soft_failed (and NOT rejected)
  await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT rejected, soft_failed FROM event_index WHERE event_id = $1;',
      [msg.event_id],
    );
    assertEquals(r.rows.length, 1);
    assertEquals(r.rows[0].rejected, false);
    assertEquals(r.rows[0].soft_failed, true);
  });

  // not an extremity for authoring purposes
  const room = (await lookupRoom(ROOM))!;
  const xb = await extremities(room.dbName, ROOM);
  assert(
    !xb.some((e) => e.eventId === msg.event_id),
    'soft-failed event must not be an extremity',
  );

  // excluded from the client-visible timeline
  const { messages } = await import('#engine/timeline.ts');
  const visible = await messages(room.dbName, ROOM, 50);
  assert(
    !visible.some((m) =>
      (m as { event_id?: string }).event_id === msg.event_id
    ),
    'soft-failed event must not be returned by messages()',
  );

  // and never in state (a message event cannot be, but pin the contract)
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow(room.dbName)) as any[];
  assert(!st.some((r) => r.event_id === msg.event_id));

  // the replay oracle: the RESOLVED state keeps the ban (the soft-failed
  // message cannot inject state) — bob stays banned after re-resolution
  await reresolveFromDag(ROOM);
  // deno-lint-ignore no-explicit-any
  const resolved = (await stateNow(room.dbName)) as any[];
  const bobRow = resolved.find((r) => r.state_key === '@bob:localhost');
  assertEquals(bobRow?.content?.membership, 'ban');
});
