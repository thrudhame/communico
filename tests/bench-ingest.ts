// Phase 4 — ingest throughput bench (plain script, NOT deno bench:
// bench re-runs bodies unpredictably against stateful DBs).
// Run: deno run --env --allow-net --allow-env --allow-read tests/bench-ingest.ts
import { createRoom, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!bench:localhost';

await resetRoom(ROOM);
await createRoom(ROOM, '11', '@dev:localhost');
const room = (await lookupRoom(ROOM))!;

// chain off the current extremity
let prev = await latestExtremityEventId(ROOM);

async function sendOne(i: number): Promise<number> {
  const t0 = performance.now();
  const pdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: `bench ${i}`, msgtype: 'm.text' },
    prev_events: [prev],
    origin_server_ts: Date.now(),
  });
  const r = await ingestEvent(ROOM, pdu);
  prev = r.event_id;
  return performance.now() - t0;
}

// warm-up: 10 events, not timed
for (let i = 0; i < 10; i++) await sendOne(i);

// timed run 1: 200 events
let t0 = performance.now();
let lastMs = 0;
for (let i = 0; i < 200; i++) lastMs = await sendOne(10 + i);
const run1Ms = performance.now() - t0;
const run1PerSec = 200 / (run1Ms / 1000);
console.log(
  `run 1: total ${run1Ms.toFixed(0)} ms, ${
    run1PerSec.toFixed(1)
  } events/sec, last event ${lastMs.toFixed(1)} ms`,
);

// timed run 2: 200 more (400 total) — growth behavior via the ratio
t0 = performance.now();
for (let i = 0; i < 200; i++) lastMs = await sendOne(210 + i);
const run2Ms = performance.now() - t0;
const run2PerSec = 200 / (run2Ms / 1000);
console.log(
  `run 2: total ${run2Ms.toFixed(0)} ms, ${
    run2PerSec.toFixed(1)
  } events/sec, last event ${lastMs.toFixed(1)} ms`,
);
console.log(`ratio run2/run1: ${(run2PerSec / run1PerSec).toFixed(2)}`);
console.log(`room db: ${room.dbName}`);
