// demo/fork-demo.ts — creates a real fork + merge in the demo room so the
// inspection tour has a 2-parent merge commit to look at.
// Reuses the keepPrevBranches test hook exactly like tests/merge.test.ts.
// Run (inside the container): deno run --env --allow-net --allow-env --allow-read demo/fork-demo.ts
import { ingestEvent } from '../api/engine/ingest.ts';
import { lookupRoom } from '../api/engine/room.ts';
import { latestExtremityEventId } from '../tests/util.ts';
import { withDb } from '../api/engine/db.ts';

const roomId = Deno.args[0];
if (!roomId) {
  console.error('usage: fork-demo.ts <roomId>');
  Deno.exit(2);
}
const room = await lookupRoom(roomId);
if (!room) throw new Error('room not found: ' + roomId);

const base = await latestExtremityEventId(roomId);

// E2a / E2b both have prev = [base] (fork), E3 merges them.
const e2a = await ingestEvent(roomId, {
  type: 'm.room.topic',
  state_key: '',
  sender: '@alice:localhost',
  content: { topic: 'cats (fork side A)' },
  prev_events: [base],
  origin_ts: 1000,
}, { keepPrevBranches: true });
const e2b = await ingestEvent(roomId, {
  type: 'm.room.topic',
  state_key: '',
  sender: '@bob:localhost',
  content: { topic: 'dogs (fork side B)' },
  prev_events: [base],
  origin_ts: 2000,
});
const e3 = await ingestEvent(roomId, {
  type: 'm.room.message',
  sender: '@alice:localhost',
  content: { body: 'merge: topic resolved latest-wins -> dogs', msgtype: 'm.text' },
  prev_events: [e2a.event_id, e2b.event_id],
  origin_ts: 3000,
});

await withDb(room.dbName, async (c) => {
  const anc = await c.query(
    'SELECT parent_hash FROM dolt.commit_ancestors WHERE commit_hash = $1;',
    [e3.commit_hash],
  );
  console.log('merge commit:', e3.commit_hash);
  // deno-lint-ignore no-explicit-any
  console.log('parents:', anc.rows.map((r: any) => String(r.parent_hash)).join(', '));
  console.log('wire event id of the merge event:', e3.event_id);
});
console.log('fork-demo complete: E2a, E2b forked; E3 merged with 2 parents.');
