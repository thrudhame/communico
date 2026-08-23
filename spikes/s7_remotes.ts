// S7 — remotes (keystone for Phase 3 only)
// Proves: push/pull between two local Doltgres databases via a file remote.
// Run with: deno run --allow-net --allow-env --allow-write spikes/s7_remotes.ts
// (allow-write needed for Deno.mkdir of /tmp/remotes)
import type pgpkg from 'pg';
import { makeClient, Spike } from './harness.ts';

async function tryQuiet(client: pgpkg.Client, sql: string) {
  try {
    const res = await client.query(sql);
    return res.rows;
  } catch {
    return null;
  }
}

const spike = new Spike('S7 — remotes');

// 1. mkdir /tmp/remotes
try {
  await Deno.mkdir('/tmp/remotes', { recursive: true });
  spike.record("Deno.mkdir('/tmp/remotes')", true, 'created (or already existed)');
} catch (e) {
  spike.record("Deno.mkdir('/tmp/remotes')", false, String(e));
}

// 2. add remote on spike_room1
const room = makeClient({ database: 'spike_room1' });
await room.connect();
await spike.try(room, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");
const countRows = await spike.try(
  room,
  't1 count on spike_room1 (main)',
  'SELECT count(*) AS c FROM t1;',
);
const roomCount = countRows ? Number(countRows[0].c) : null;
await spike.try(
  room,
  "DOLT_REMOTE('add', 'origin', 'file:///tmp/remotes/spike_room1')",
  "SELECT DOLT_REMOTE('add', 'origin', 'file:///tmp/remotes/spike_room1');",
);

// 3. push main
await spike.try(room, "DOLT_PUSH('origin', 'main')", "SELECT DOLT_PUSH('origin', 'main');");

// 4. clone on postgres db
const root = makeClient();
await root.connect();
await spike.try(
  root,
  "DOLT_CLONE('file:///tmp/remotes/spike_room1', 'spike_clone')",
  "SELECT DOLT_CLONE('file:///tmp/remotes/spike_room1', 'spike_clone');",
);
await root.end();

// 5. clone has same t1 count
const clone = makeClient({ database: 'spike_clone' });
await clone.connect();
const cloneRows = await spike.try(
  clone,
  't1 count on spike_clone',
  'SELECT count(*) AS c FROM t1;',
);
if (cloneRows && roomCount !== null) {
  const cc = Number(cloneRows[0].c);
  spike.record('clone count == room count', cc === roomCount, `clone=${cc} room=${roomCount}`);
}

// 6. new row on spike_room1, commit, push
await spike.try(room, "INSERT (99,'sync')", "INSERT INTO t1 VALUES (99, 'sync');");
await spike.try(room, "DOLT_COMMIT 's7 new row'", "SELECT DOLT_COMMIT('-Am', 's7 new row');");
await spike.try(room, "DOLT_PUSH('origin', 'main') #2", "SELECT DOLT_PUSH('origin', 'main');");

// 7. pull on clone; alternate: DOLT_PULL() with no args
let pull = await tryQuiet(clone, "SELECT DOLT_PULL('origin');");
let pullForm = "SELECT DOLT_PULL('origin');";
if (pull === null) {
  pull = await tryQuiet(clone, 'SELECT DOLT_PULL();');
  pullForm = 'SELECT DOLT_PULL();';
}
spike.record(
  'DOLT_PULL on spike_clone',
  pull !== null,
  pull !== null ? { form: pullForm, returned: pull.slice(0, 5) } : 'both forms failed',
);

// 8. row 99 present on clone
const r99 = await spike.try(
  clone,
  'SELECT * FROM t1 WHERE id = 99 on spike_clone',
  'SELECT * FROM t1 WHERE id = 99;',
);
if (r99) {
  spike.record('row 99 present on clone', r99.length === 1, `${r99.length} row(s)`);
}

await room.end();
await clone.end();
Deno.exit(spike.finish() ? 0 : 1);
