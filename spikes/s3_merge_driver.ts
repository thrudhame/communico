// S3 — merge driver (KEYSTONE — the most important spike)
// REVISED per D6 (Path B, validated): sanctioned merge mechanism =
// session variable dolt_allow_commit_conflicts.
// Goal: land a 2-parent merge commit whose conflicting-row content WE
// dictate.
import { makeClient, Spike } from './harness.ts';

const spike = new Spike('S3 — merge driver');

// ONE client for the whole sequence (steps 1-12): the held conflict state
// dies with the session, so 5-10 must stay on this client.
const c = makeClient({ database: 'spike_room1' });
await c.connect();

// fresh client, checkout main
await spike.try(c, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");

// 1. base
await spike.try(c, 'CREATE TABLE state', 'CREATE TABLE state (k text PRIMARY KEY, v text);');
await spike.try(c, 'INSERT base topic', "INSERT INTO state VALUES ('topic', 'origin');");
await spike.try(c, "DOLT_COMMIT 's3 base'", "SELECT DOLT_COMMIT('-Am', 's3 base');");

// 2. ma sets cats
await spike.try(c, "DOLT_CHECKOUT('-b', 'ma')", "SELECT DOLT_CHECKOUT('-b', 'ma');");
await spike.try(c, 'ma: topic=cats', "UPDATE state SET v = 'cats' WHERE k = 'topic';");
await spike.try(c, "DOLT_COMMIT 's3 ma sets cats'", "SELECT DOLT_COMMIT('-Am', 's3 ma sets cats');");

// 3. mb sets dogs
await spike.try(c, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");
await spike.try(c, "DOLT_CHECKOUT('-b', 'mb')", "SELECT DOLT_CHECKOUT('-b', 'mb');");
await spike.try(c, 'mb: topic=dogs', "UPDATE state SET v = 'dogs' WHERE k = 'topic';");
await spike.try(c, "DOLT_COMMIT 's3 mb sets dogs'", "SELECT DOLT_COMMIT('-Am', 's3 mb sets dogs');");

// 4. checkout ma
await spike.try(c, "DOLT_CHECKOUT('ma')", "SELECT DOLT_CHECKOUT('ma');");

// 5. D6 sanctioned merge mechanism (session variable, same client)
await spike.try(
  c,
  'SET dolt_allow_commit_conflicts = 1 (D6)',
  'SET dolt_allow_commit_conflicts = 1;',
);

// 6. merge — expect NO error and a result containing 'conflicts found'
const mergeRows = await spike.try(c, "DOLT_MERGE('mb')", "SELECT DOLT_MERGE('mb');");
if (mergeRows) {
  const shape = String(mergeRows[0]?.dolt_merge ?? '');
  spike.record(
    "merge result contains 'conflicts found'",
    shape.includes('conflicts found'),
    shape,
  );
}

// 7. conflicts: state listed, num_conflicts = 1; record conflicts-detail columns
const conflicts = await spike.try(c, 'SELECT * FROM dolt.conflicts', 'SELECT * FROM dolt.conflicts;');
if (conflicts) {
  const hasState = conflicts.some((r) => String(r.table) === 'state');
  const num = conflicts.find((r) => String(r.table) === 'state')?.num_conflicts;
  spike.record('dolt.conflicts lists state', hasState, JSON.stringify(conflicts));
  spike.record("num_conflicts == 1 for 'state'", Number(num) === 1, String(num));
}
const detail = await spike.try(
  c,
  'SELECT * FROM dolt_conflicts_state',
  'SELECT * FROM dolt_conflicts_state;',
);
if (detail && detail.length > 0) {
  spike.record('dolt_conflicts_state columns', true, Object.keys(detail[0]).join(', '));
}

// 8. resolve OUR way
await spike.try(
  c,
  "DOLT_CONFLICTS_RESOLVE('--ours', 'state')",
  "SELECT DOLT_CONFLICTS_RESOLVE('--ours', 'state');",
);
await spike.try(
  c,
  'UPDATE state DRIVER-DECIDED',
  "UPDATE state SET v = 'DRIVER-DECIDED' WHERE k = 'topic';",
);

// 9. GUARD: conflicts must be empty before commit
const guard = await spike.try(c, 'GUARD: dolt.conflicts empty', 'SELECT * FROM dolt.conflicts;');
if (guard) {
  spike.record('GUARD result', guard.length === 0, `${guard.length} row(s)`);
  if (guard.length > 0) {
    console.log('GUARD FAILED — aborting per README (never commit unresolved conflicts)');
    await c.end();
    spike.finish();
    Deno.exit(1);
  }
}

// 10. commit the merge
await spike.try(
  c,
  "DOLT_COMMIT('-Am', 's3 merge with driver content')",
  "SELECT DOLT_COMMIT('-Am', 's3 merge with driver content');",
);

// 11. KEYSTONE: exactly 2 distinct parents (scalar-subquery form —
// required due to known planner bug)
const anc = await spike.try(
  c,
  'commit_ancestors of (SELECT HASHOF(ma))',
  'SELECT parent_hash FROM dolt.commit_ancestors WHERE commit_hash = (SELECT HASHOF(\'ma\'));',
);
if (anc) {
  const parents = anc.map((r) => String(r.parent_hash));
  const distinct = new Set(parents);
  spike.record(
    'KEYSTONE: EXACTLY 2 distinct parents',
    anc.length === 2 && distinct.size === 2,
    `${anc.length} row(s), parents: ${parents.join(', ')}`,
  );
}

// 12. content: live + AS OF merge tip
const live = await spike.try(c, "live: SELECT v FROM state WHERE k='topic'", "SELECT v FROM state WHERE k = 'topic';");
if (live) {
  const v = live.length > 0 ? String(live[0].v) : '(no row)';
  spike.record("live content == 'DRIVER-DECIDED'", v === 'DRIVER-DECIDED', v);
}
const asof = await spike.try(
  c,
  "AS OF: SELECT v FROM state AS OF HASHOF('ma') WHERE k='topic'",
  "SELECT v FROM state AS OF HASHOF('ma') WHERE k = 'topic';",
);
if (asof) {
  const v = asof.length > 0 ? String(asof[0].v) : '(no row)';
  spike.record("AS OF content == 'DRIVER-DECIDED'", v === 'DRIVER-DECIDED', v);
}

await c.end();
Deno.exit(spike.finish() ? 0 : 1);
