// S4 — N-parent commits (expected gap — not a keystone)
// Question: does any path to >2-parent commits exist? Expected: no.
import { makeClient, Spike } from './harness.ts';

const spike = new Spike('S4 — n-parent commits');

const c = makeClient({ database: 'spike_room1' });
await c.connect();

// 1. third branch mc off main, value 'birds' (same pattern as S3 step 3)
await spike.try(c, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");
await spike.try(c, "DOLT_CHECKOUT('-b', 'mc')", "SELECT DOLT_CHECKOUT('-b', 'mc');");
await spike.try(c, "mc: topic=birds", "UPDATE state SET v = 'birds' WHERE k = 'topic';");
await spike.try(c, "DOLT_COMMIT 's4 mc sets birds'", "SELECT DOLT_COMMIT('-Am', 's4 mc sets birds');");

// 2. attempt a 3-way merge in one commit — EXPECTED TO FAIL
let mergeErr = '';
let mergeWorked = false;
try {
  const r = await c.query("SELECT DOLT_MERGE('mb', 'mc');");
  mergeWorked = true;
  spike.record("DOLT_MERGE('mb', 'mc') two-branch form", true, r.rows.slice(0, 5));
} catch (e) {
  mergeErr = String(e);
  spike.record(
    "DOLT_MERGE('mb', 'mc') two-branch form",
    true, // failure is the EXPECTED outcome for this spike
    `failed as expected. Exact error: ${mergeErr}`,
  );
}

// 3. confirm max 2 parents anywhere
// scalar-subquery form per README convention (bare '= HASHOF(ma)' errors
// on merge tips — known planner bug); ma's tip IS a merge commit now
const ancMa = await spike.try(
  c,
  "commit_ancestors of (SELECT HASHOF('ma'))",
  "SELECT * FROM dolt.commit_ancestors WHERE commit_hash = (SELECT HASHOF('ma'));",
);
if (ancMa) {
  spike.record(
    "parents of HASHOF('ma')",
    ancMa.length <= 2,
    `${ancMa.length} parent row(s)`,
  );
}
const maxParents = await spike.try(
  c,
  'max parents per commit (whole graph)',
  'SELECT commit_hash, COUNT(*) AS parents FROM dolt.commit_ancestors GROUP BY commit_hash ORDER BY parents DESC LIMIT 3;',
);
if (maxParents) {
  const max = Math.max(...maxParents.map((r) => Number(r.parents)));
  spike.record('max parents anywhere <= 2', max <= 2, `max = ${max}`);
}

// 4. final status: EXPECTED_GAP if step 2 failed, PASS (major news) if it worked
const status = mergeWorked ? 'PASS' : 'EXPECTED_GAP';
console.log(`SPIKE S4 — n-parent commits: ${status}`);
if (mergeWorked) {
  console.log('!!! MAJOR NEWS: DOLT_MERGE accepted two branches — N-parent merges may be possible');
}
console.log('RESULTS-BLOCK-START');
console.log('## S4 — n-parent commits');
console.log(`Status: ${status}`);
for (const r of spike.results) {
  console.log(`- ${r.ok ? 'ok' : 'FAIL'} ${r.label}: ${r.detail}`);
}
console.log('RESULTS-BLOCK-END');

await c.end();
Deno.exit(0);
