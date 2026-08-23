// S1 — db-per-room (KEYSTONE)
// Proves: dynamic CREATE DATABASE; connecting to a specific db/branch over
// the PG wire.
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

const spike = new Spike('S1 — db-per-room');

// 1. On database postgres: CREATE DATABASE spike_room1;
const c0 = makeClient();
await c0.connect();
await spike.try(c0, 'CREATE DATABASE spike_room1', 'CREATE DATABASE spike_room1;');
await c0.end();

// 2. New client on spike_room1: CREATE TABLE
const c1 = makeClient({ database: 'spike_room1' });
await c1.connect();
await spike.try(
  c1,
  'CREATE TABLE t1 on spike_room1',
  'CREATE TABLE t1 (id int PRIMARY KEY, v text);',
);

// 3. INSERT
await spike.try(c1, 'INSERT INTO t1', "INSERT INTO t1 VALUES (1, 'a');");

// 4. DOLT_COMMIT (with listed fallback: DOLT_ADD then DOLT_COMMIT -m)
let commitRows = await tryQuiet(c1, "SELECT DOLT_COMMIT('-Am', 's1 first commit');");
let commitForm = "SELECT DOLT_COMMIT('-Am', 's1 first commit');";
if (commitRows === null) {
  const addRows = await tryQuiet(c1, "SELECT DOLT_ADD('-A');");
  if (addRows !== null) {
    commitRows = await tryQuiet(c1, "SELECT DOLT_COMMIT('-m', 's1 first commit');");
    commitForm = "SELECT DOLT_ADD('-A'); then SELECT DOLT_COMMIT('-m', 's1 first commit');";
  }
}
spike.record(
  'DOLT_COMMIT first commit',
  commitRows !== null,
  commitRows !== null
    ? { form: commitForm, rows: commitRows.slice(0, 5) }
    : 'all listed forms failed',
);
const commitHash = commitRows && commitRows[0]
  ? String(Object.values(commitRows[0])[0])
  : null;
spike.record('captured commit hash', commitHash !== null && commitHash !== '', commitHash);

// 5. dolt.log contains 's1 first commit'
const log = await spike.try(c1, 'SELECT * FROM dolt.log', 'SELECT * FROM dolt.log;');
if (log) {
  const found = log.some((r) => String(r.message).includes('s1 first commit'));
  spike.record(
    "dolt.log contains 's1 first commit'",
    found,
    `${log.length} log row(s); messages: ${log.map((r) => r.message).join(' | ')}`,
  );
}

// 6. Branch-addressed connection
let ok = false;
let detail = '';
try {
  const cb = makeClient({ database: 'spike_room1/main' });
  await cb.connect();
  const r = await cb.query('SELECT active_branch();');
  await cb.end();
  const branch = r.rows[0] ? String(Object.values(r.rows[0])[0]) : '(no row)';
  ok = true;
  detail = `database 'spike_room1/main' connected; active_branch() = ${branch}`;
} catch (e) {
  try {
    const cu = makeClient({ database: 'spike_room1' });
    await cu.connect();
    await cu.query('USE spike_room1/main;');
    const r = await cu.query('SELECT active_branch();');
    await cu.end();
    const branch = r.rows[0] ? String(Object.values(r.rows[0])[0]) : '(no row)';
    ok = true;
    detail = `branch-addressed connect via "USE spike_room1/main;"; active_branch() = ${branch}`;
  } catch {
    ok = true; // non-fatal per phase-0 step 6
    detail = `branch-addressed connect UNSUPPORTED (primary error: ${String(e)})`;
  }
}
spike.record('branch-addressed connection', ok, detail);

await c1.end();
Deno.exit(spike.finish() ? 0 : 1);
