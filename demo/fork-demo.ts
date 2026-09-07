// demo/fork-demo.ts — creates a real fork in the demo room so the
// inspection tour has concurrent branches to look at. Under the F0
// refusing stub the heal is REFUSED (M_UNRESOLVED_CONFLICT): the room
// stays forked, nothing is guessed.
// Reuses the keepPrevBranches test hook exactly like tests/merge.test.ts.
// Run (inside the container): deno run --env --allow-net --allow-env --allow-read demo/fork-demo.ts
import { author, ingestEvent } from '../api/engine/ingest.ts';
import { lookupRoom } from '../api/engine/room.ts';
import { latestExtremityEventId } from '../tests/util.ts';

const roomId = Deno.args[0];
if (!roomId) {
  console.error('usage: fork-demo.ts <roomId>');
  Deno.exit(2);
}
const room = await lookupRoom(roomId);
if (!room) throw new Error('room not found: ' + roomId);

const base = await latestExtremityEventId(roomId);

// E2a / E2b both have prev = [base] (fork): concurrent topic edits.
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
    sender: '@bob:localhost',
    content: { topic: 'dogs (fork side B)' },
    prev_events: [base],
    origin_server_ts: 2000,
  }),
);
// E3 tries to merge the fork — the stub refuses (no guessed winner).
try {
  await ingestEvent(
    roomId,
    await author(roomId, {
      type: 'm.room.message',
      sender: '@alice:localhost',
      content: { body: 'heal attempt', msgtype: 'm.text' },
      prev_events: [e2a.event_id, e2b.event_id],
      origin_server_ts: 3000,
    }),
  );
  console.log('UNEXPECTED: heal applied');
} catch (e) {
  console.log('heal refused as designed:', String(e).split(':')[0]);
}
console.log('fork-demo complete: E2a, E2b forked; heal refused, room stays forked.');
