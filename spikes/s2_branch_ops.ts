// S2 — branch ops (KEYSTONE)
// Proves: dolt_branch, checkout, commit, dolt_log via SQL; branch
// create/delete; session branch scope.
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

const spike = new Spike('S2 — branch ops');

const c = makeClient({ database: 'spike_room1' });
await c.connect();

// 1. checkout main
await spike.try(c, "DOLT_CHECKOUT('main')", "SELECT DOLT_CHECKOUT('main');");

// 2. create branch b1
await spike.try(c, "DOLT_BRANCH('b1')", "SELECT DOLT_BRANCH('b1');");

// 3. checkout b1, verify active_branch
await spike.try(c, "DOLT_CHECKOUT('b1')", "SELECT DOLT_CHECKOUT('b1');");
const ab = await spike.try(c, 'active_branch on b1', 'SELECT active_branch();');
if (ab) {
  const v = String(Object.values(ab[0])[0]);
  spike.record('active_branch() == b1', v === 'b1', v);
}

// 4. insert + commit on b1
await spike.try(c, "INSERT (2,'b')", "INSERT INTO t1 VALUES (2, 'b');");
await spike.try(
  c,
  "DOLT_COMMIT s2 on b1",
  "SELECT DOLT_COMMIT('-Am', 's2 commit on b1');",
);

// 5. dolt_log('b1') contains the commit
const logB1 = await spike.try(c, "dolt_log('b1')", "SELECT * FROM dolt_log('b1');");
if (logB1) {
  const found = logB1.some((r) => String(r.message).includes('s2 commit on b1'));
  spike.record(
    "dolt_log('b1') contains 's2 commit on b1'",
    found,
    `${logB1.length} row(s); messages: ${logB1.map((r) => r.message).join(' | ')}`,
  );
}

// 6. HASHOF('b1') != HASHOF('main')
const hb = await spike.try(c, "HASHOF('b1')", "SELECT HASHOF('b1');");
const hm = await spike.try(c, "HASHOF('main')", "SELECT HASHOF('main');");
if (hb && hm) {
  const vb = String(Object.values(hb[0])[0]);
  const vm = String(Object.values(hm[0])[0]);
  spike.record('HASHOF(b1) != HASHOF(main)', vb !== vm, `b1=${vb} main=${vm}`);
}

// 7. Session-scope check: SECOND client, active_branch()
const c2 = makeClient({ database: 'spike_room1' });
await c2.connect();
const ab2 = await spike.try(
  c2,
  'second client active_branch() (session scope)',
  'SELECT active_branch();',
);
if (ab2) {
  const v = String(Object.values(ab2[0])[0]);
  spike.record('second-client branch value recorded', true, `active_branch() on fresh client = '${v}'`);
}
await c2.end();

// 8. dolt.branches lists main and b1
const branches = await spike.try(c, 'SELECT * FROM dolt.branches', 'SELECT * FROM dolt.branches;');
if (branches) {
  const names = branches.map((r) => String(r.name));
  spike.record(
    'dolt.branches lists main and b1',
    names.includes('main') && names.includes('b1'),
    names.join(', '),
  );
}

// 9. delete b1 (after checkout main); fallback -D
await spike.try(c, "DOLT_CHECKOUT('main') before delete", "SELECT DOLT_CHECKOUT('main');");
let del = await tryQuiet(c, "SELECT DOLT_BRANCH('-d', 'b1');");
let delForm = "SELECT DOLT_BRANCH('-d', 'b1');";
if (del === null) {
  del = await tryQuiet(c, "SELECT DOLT_BRANCH('-D', 'b1');");
  delForm = "SELECT DOLT_BRANCH('-D', 'b1');";
}
spike.record('delete branch b1', del !== null, del !== null ? `form: ${delForm}` : 'both -d and -D failed');

await c.end();
Deno.exit(spike.finish() ? 0 : 1);
