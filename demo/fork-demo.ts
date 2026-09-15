// demo/fork-demo.ts — demonstrates the M3 rulebook on the demo room:
// (1) power levels are ENFORCED — bob (level 0, below state_default 50)
// cannot set the topic (the event is state-rejected per auth rule 7);
// (2) a real fork of concurrent topic edits by a powered user RESOLVES —
// the heal converges to one extremity with the spec-determined winner
// (state resolution v2: same sender power, earlier origin_server_ts
// orders first, the later-applied side wins the key).
// Reuses the keepPrevBranches test hook exactly like tests/merge.test.ts.
// Run (inside the container): deno run --env --allow-net --allow-env --allow-read demo/fork-demo.ts
import { author, ingestEvent } from '#engine/ingest.ts';
import { lookupRoom } from '#engine/room.ts';
import { latestExtremityEventId } from '#tests/util.ts';

const roomId = Deno.args[0];
if (!roomId) {
  console.error('usage: fork-demo.ts <roomId>');
  Deno.exit(2);
}
const room = await lookupRoom(roomId);
if (!room) throw new Error('room not found: ' + roomId);

const base = await latestExtremityEventId(roomId);

// (1) bob (no power) tries the topic — rule 7 rejects it at ingest.
try {
  await ingestEvent(
    roomId,
    await author(roomId, {
      type: 'm.room.topic',
      state_key: '',
      sender: '@bob:localhost',
      content: { topic: 'bob was here' },
      prev_events: [base],
      origin_server_ts: 500,
    }),
  );
  console.log("UNEXPECTED: bob's topic was applied");
} catch (e) {
  console.log("bob's topic rejected as designed:", String(e).split(':')[0]);
}

// (2) alice (creator, 100) forks the room: two concurrent topic edits.
const e2a = await ingestEvent(
  roomId,
  await author(roomId, {
    type: 'm.room.topic',
    state_key: '',
    sender: '@alice:localhost',
    content: { topic: 'cats (fork side A)' },
    prev_events: [base],
    origin_server_ts: 1000,
  }),
  { keepPrevBranches: true },
);
const e2b = await ingestEvent(
  roomId,
  await author(roomId, {
    type: 'm.room.topic',
    state_key: '',
    sender: '@alice:localhost',
    content: { topic: 'dogs (fork side B)' },
    prev_events: [base],
    origin_server_ts: 2000,
  }),
);
// E3 merges the fork — M3: concurrent state edits RESOLVE. The S4
// orderings decide: same sender power, so ts asc puts E2a first, E2b
// applies last and wins the key.
const e3 = await ingestEvent(
  roomId,
  await author(roomId, {
    type: 'm.room.message',
    sender: '@alice:localhost',
    content: { body: 'heal', msgtype: 'm.text' },
    prev_events: [e2a.event_id, e2b.event_id],
    origin_server_ts: 3000,
  }),
);
console.log(
  "fork-demo complete: bob's write rejected (rule 7); fork healed at",
  e3.event_id,
);
