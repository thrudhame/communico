// S5 — AS OF / dolt_diff (KEYSTONE)
// Proves: AS OF <commit> reads; dolt_diff between two arbitrary commits.
import { makeClient, Spike } from './harness.ts';

const spike = new Spike('S5 — asof/diff');

const c = makeClient({ database: 'spike_room1' });
await c.connect();
await spike.try(c, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");

const log = await spike.try(
  c,
  'SELECT commit_hash FROM dolt.log LIMIT 5',
  'SELECT commit_hash FROM dolt.log LIMIT 5;',
);

if (log && log.length >= 2) {
  // messages (newest first): s3 base, s1 first commit, CREATE DATABASE, init
  const H1: string = log[0].commit_hash; // newest
  const H_OLDEST: string = log[log.length - 1].commit_hash; // oldest (init)
  const H_S1: string = log[1].commit_hash; // 's1 first commit'
  spike.record('hashes chosen', true, `H1(newest)=${H1}; H2a=${H_S1}; H2b(oldest)=${H_OLDEST}`);

  // 1. AS OF older state.
  // NOTE (recorded deviation): `AS OF` a commit predating t1's creation errors
  // with "table not found: t1", so step 1 uses H2a = 's1 first commit'.
  const asof = await spike.try(
    c,
    "SELECT * FROM t1 AS OF H2a('s1 first commit')",
    `SELECT * FROM t1 AS OF '${H_S1}';`,
  );
  if (asof) {
    const hasB = asof.some((r) => Number(r.id) === 2);
    spike.record(
      "AS OF returns older row set, row (2,'b') absent",
      !hasB,
      `rows: ${JSON.stringify(asof)}`,
    );
  }
  // record what AS OF at the oldest hash does (pre-table commit);
  // the error IS the documented behavior, so it records ok with detail
  try {
    const r = await c.query(`SELECT * FROM t1 AS OF '${H_OLDEST}';`);
    spike.record(
      'SELECT * FROM t1 AS OF H2b(init, pre-table) — behavior probe',
      true,
      `returned ${r.rows.length} row(s) (no error)`,
    );
  } catch (e) {
    spike.record(
      'SELECT * FROM t1 AS OF H2b(init, pre-table) — behavior probe',
      true,
      `errors as documented: ${String(e)}`,
    );
  }

  // 2 + 3. dolt_diff / dolt_diff_stat.
  // NOTE (recorded deviation): t1 is unchanged between 's1 first commit' and
  // H1, so the diff pair uses H2b (oldest) to span t1's creation.
  const diff = await spike.try(
    c,
    'dolt_diff(H2b=init, H1, t1)',
    `SELECT * FROM dolt_diff('${H_OLDEST}', '${H1}', 't1');`,
  );
  if (diff) {
    spike.record(
      'dolt_diff returns >= 1 row',
      diff.length >= 1,
      `${diff.length} row(s); columns: ${diff.length > 0 ? Object.keys(diff[0]).join(', ') : '(none)'}`,
    );
  }
  await spike.try(
    c,
    'dolt_diff(s1 first commit, H1, t1) — unchanged-table probe',
    `SELECT * FROM dolt_diff('${H_S1}', '${H1}', 't1');`,
  );
  const stat = await spike.try(
    c,
    'dolt_diff_stat(H2b=init, H1, t1)',
    `SELECT * FROM dolt_diff_stat('${H_OLDEST}', '${H1}', 't1');`,
  );
  if (stat) {
    spike.record('dolt_diff_stat returns 1 row', stat.length === 1, `${stat.length} row(s)`);
  }
}

// 4. USE spike_room1/main; — non-fatal either way
try {
  await c.query('USE spike_room1/main;');
  const ab = await c.query('SELECT active_branch();');
  spike.record(
    'USE spike_room1/main',
    true,
    `supported; active_branch() = ${JSON.stringify(ab.rows[0])}`,
  );
} catch (e) {
  spike.record('USE spike_room1/main', true, `unsupported (non-fatal): ${String(e)}`);
}

await c.end();
Deno.exit(spike.finish() ? 0 : 1);
