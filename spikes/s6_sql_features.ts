// S6 — SQL features (informational — no keystone)
// Status is PASS if the script runs to the end, regardless of individual
// item failures.
import { makeClient, Spike } from './harness.ts';

const spike = new Spike('S6 — sql features');

const c = makeClient({ database: 'spike_room1' });
await c.connect();
await spike.try(c, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");

// 1. JSONB fallback ladder: jsonb -> json -> text
let rung: string | null = null;
for (const candidate of ['jsonb', 'json', 'text']) {
  try {
    await c.query('DROP TABLE IF EXISTS j1;');
    await c.query(`CREATE TABLE j1 (id int PRIMARY KEY, doc ${candidate});`);
    await c.query(`INSERT INTO j1 VALUES (1, '{"a": {"b": 7}}');`);
    const r = await c.query(`SELECT doc->'a'->>'b' AS x FROM j1;`);
    const x = String(r.rows[0]?.x);
    if (candidate !== 'text' && x !== '7') {
      throw new Error(`->> returned '${x}', expected '7'`);
    }
    rung = candidate;
    spike.record(
      `JSON rung '${candidate}'`,
      true,
      candidate === 'text'
        ? 'stored as text (engine must JSON.stringify/parse Deno-side)'
        : `doc->'a'->>'b' = ${x}`,
    );
    break;
  } catch (e) {
    spike.record(`JSON rung '${candidate}'`, false, String(e));
  }
}
if (rung === null) {
  spike.record('JSON support', false, 'all rungs (jsonb, json, text) failed');
}

// 2. recursive CTE
await spike.try(
  c,
  'recursive CTE',
  `WITH RECURSIVE nums(n) AS (
     SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 5
   ) SELECT count(*) AS c FROM nums;`,
);
try {
  const r = await c.query(`WITH RECURSIVE nums(n) AS (
     SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 5
   ) SELECT count(*) AS c FROM nums;`);
  spike.record('recursive CTE count == 5', Number(r.rows[0]?.c) === 5, String(r.rows[0]?.c));
} catch {
  /* already recorded as FAIL above */
}

// 3. PL/pgSQL
const fnOk = await spike.try(
  c,
  'CREATE FUNCTION spike_add (plpgsql)',
  `CREATE FUNCTION spike_add(a int, b int) RETURNS int AS $$
   BEGIN RETURN a + b; END; $$ LANGUAGE plpgsql;`,
);
if (fnOk) {
  try {
    const r = await c.query('SELECT spike_add(2, 3);');
    const v = String(Object.values(r.rows[0])[0]);
    spike.record('spike_add(2,3) == 5', v === '5', v);
  } catch (e) {
    spike.record('spike_add(2,3)', false, String(e));
  }
}

// 4. commit so S7 has a clean tree
try {
  const r = await c.query("SELECT DOLT_COMMIT('-Am', 's6 features');");
  spike.record("DOLT_COMMIT 's6 features'", true, r.rows.slice(0, 5));
} catch (e) {
  const msg = String(e);
  spike.record(
    "DOLT_COMMIT 's6 features'",
    msg.includes('nothing to commit'),
    msg.includes('nothing to commit') ? 'nothing to commit (tree already clean)' : msg,
  );
}

// S6 status: PASS if the script ran to the end (this line), regardless of ❌s
console.log('RESULTS-BLOCK-START');
console.log('## S6 — sql features');
console.log('Status: PASS');
for (const r of spike.results) {
  console.log(`- ${r.ok ? 'ok' : 'FAIL'} ${r.label}: ${r.detail}`);
}
console.log('RESULTS-BLOCK-END');

await c.end();
Deno.exit(0);
