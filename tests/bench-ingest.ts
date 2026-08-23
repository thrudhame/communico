// Phase 4 — ingest throughput bench (plain script, NOT deno bench:
// bench re-runs bodies unpredictably against stateful DBs).
// Run: deno run --env --allow-net --allow-env --allow-read tests/bench-ingest.ts
import {
  createRoom,
  dbNameFor,
  lookupRoom,
} from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { SERVER_DB, withDb } from '../api/engine/db.ts';

const ROOM = '!bench:localhost';

async function cleanup() {
  const dbName = await dbNameFor(ROOM);
  await withDb(SERVER_DB, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName};`);
    await c.query('DELETE FROM room_directory WHERE room_id = $1;', [ROOM]);
    await c.query('DELETE FROM event_index WHERE room_id = $1;', [ROOM]);
  });
}

await cleanup();
await createRoom(ROOM, '10', '@dev:localhost');
const room = (await lookupRoom(ROOM))!;

let prev: string = await withDb(SERVER_DB, async (c) => {
  const r = await c.query(
    'SELECT event_id FROM event_index WHERE room_id = $1;',
    [ROOM],
  );
  return String(r.rows[0].event_id);
});

async function sendOne(i: number): Promise<number> {
  const t0 = performance.now();
  const r = await ingestEvent(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: `bench ${i}`, msgtype: 'm.text' },
    prev_events: [prev],
    origin_ts: Date.now(),
  });
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
console.log(`run 1: total ${run1Ms.toFixed(0)} ms, ${run1PerSec.toFixed(1)} events/sec, last event ${lastMs.toFixed(1)} ms`);

// timed run 2: 200 more (400 total) — growth behavior via the ratio
t0 = performance.now();
for (let i = 0; i < 200; i++) lastMs = await sendOne(210 + i);
const run2Ms = performance.now() - t0;
const run2PerSec = 200 / (run2Ms / 1000);
console.log(`run 2: total ${run2Ms.toFixed(0)} ms, ${run2PerSec.toFixed(1)} events/sec, last event ${lastMs.toFixed(1)} ms`);
console.log(`ratio run2/run1: ${(run2PerSec / run1PerSec).toFixed(2)}`);
console.log(`room db: ${room.dbName}`);
