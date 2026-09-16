// tests/extremities.test.ts — E4 (Synapse persist_events.py:1052-1111,
// _calculate_new_extremities): rejected and soft-failed events neither
// become extremities nor consume their prevs; an accepted event citing a
// soft-failed/rejected prev consumes that prev's branch AND walks back
// through flagged ancestors. Live doltgres.
import { assertEquals, assertRejects } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!extremities:localhost';
const ROOM3 = '!extremities3:localhost';

async function extremityIds(roomId: string): Promise<string[]> {
  const room = (await lookupRoom(roomId))!;
  return (await extremities(room.dbName, roomId)).map((e) => e.eventId)
    .sort();
}

// Invite + join bob through the engine pipeline (same shape as
// current-state.test.ts).
async function bobJoins(roomId: string): Promise<void> {
  const inviteBase = await latestExtremityEventId(roomId);
  await ingestEvent(
    roomId,
    await author(roomId, {
      type: 'm.room.member',
      state_key: '@bob:localhost',
      sender: '@dev:localhost',
      content: { membership: 'invite' },
      prev_events: [inviteBase],
      origin_server_ts: 1000,
    }),
  );
  const joinBase = await latestExtremityEventId(roomId);
  await ingestEvent(
    roomId,
    await author(roomId, {
      type: 'm.room.member',
      state_key: '@bob:localhost',
      sender: '@bob:localhost',
      content: { membership: 'join' },
      prev_events: [joinBase],
      origin_server_ts: 1001,
    }),
  );
}

Deno.test('E4: a soft-failed event consumes nothing — its prev stays an extremity', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });
  await bobJoins(ROOM);

  // fork point both branches cite; the ban keeps it alive (the hook) so
  // bob's soft-failing message can cite it
  const base = await latestExtremityEventId(ROOM);
  const ban = await author(ROOM, {
    type: 'm.room.member',
    state_key: '@bob:localhost',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    prev_events: [base],
    origin_server_ts: 2000,
  });
  await ingestEvent(ROOM, ban, { keepPrevBranches: true });

  // bob's message citing the pre-ban tip soft-fails (banned sender vs the
  // current state). E4: it must NOT consume base's branch.
  const msg = await author(ROOM, {
    type: 'm.room.message',
    sender: '@bob:localhost',
    content: { body: 'ban evasion attempt', msgtype: 'm.text' },
    prev_events: [base],
    origin_server_ts: 2001,
  });
  await ingestEvent(ROOM, msg);

  assertEquals(
    await extremityIds(ROOM),
    [ban.event_id, base].sort(),
    'soft-failed event left its prev an extremity (and is not one itself)',
  );

  // E4 walk-back: dev's accepted message citing the soft-failed event
  // consumes BOTH the soft-failed event's branch and, walking back
  // through it, base's branch. The ban branch is untouched — nobody
  // cited it.
  const heal = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'accepted over a soft-failed prev', msgtype: 'm.text' },
    prev_events: [msg.event_id!],
    origin_server_ts: 2002,
  });
  await ingestEvent(ROOM, heal);

  assertEquals(
    await extremityIds(ROOM),
    [ban.event_id, heal.event_id!].sort(),
    'accepted event citing a soft-failed prev consumed the whole flagged chain',
  );
});

Deno.test('E4: a rejected event consumes nothing', async () => {
  await resetRoom(ROOM3);
  await createRoom(ROOM3, '@dev:localhost', { roomVersion: '11' });
  await bobJoins(ROOM3);

  // bob (PL 0) sends a state event — state-reject (state_default 50).
  const tip = await latestExtremityEventId(ROOM3);
  const rejected = await author(ROOM3, {
    type: 'm.room.name',
    state_key: '',
    sender: '@bob:localhost',
    content: { name: 'bob has no power here' },
    prev_events: [tip],
    origin_server_ts: 3000,
  });
  const err = await assertRejects(() => ingestEvent(ROOM3, rejected), Error);
  assertEquals(err.message.startsWith('M_STATE_REJECT'), true);

  assertEquals(
    await extremityIds(ROOM3),
    [tip],
    'rejected event left the extremity set untouched',
  );

  // the room still authors fine from the same extremity
  const next = await author(ROOM3, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'after the rejected event', msgtype: 'm.text' },
    prev_events: [tip],
    origin_server_ts: 3001,
  });
  await ingestEvent(ROOM3, next);
  assertEquals(await extremityIds(ROOM3), [next.event_id!]);
});
