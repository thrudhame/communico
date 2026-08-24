// L1 — WASM ports of LS1/LS3/LS4/LS5 against @dolthub/doltlite-wasm.
// Same SQL and assertions as the native spikes (minus dot-commands).
// Branch switching: CLI '<db>@<branch>' filename is probed (INFO line);
// the spikes themselves use per-connection SELECT dolt_checkout('<b>')
// (sanctioned substitute per phase-l1 step 3).
import sqlite3InitModule from './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs';

const out = document.querySelector('#results');
out.textContent = '';
const line = (s) => { out.textContent += s + '\n'; };

const SCHEMA = `
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL, state_key TEXT, sender TEXT NOT NULL,
  origin_ts INTEGER NOT NULL, canonical_json TEXT NOT NULL
);
CREATE TABLE state (
  type TEXT NOT NULL, state_key TEXT NOT NULL,
  event_id TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (type, state_key)
);`;

function config(db) {
  // L0 finding: dolt_config SET is session/connection-scoped → same connection.
  db.exec(`SELECT dolt_config('user.name','POC')`);
  db.exec(`SELECT dolt_config('user.email','poc@localhost')`);
}

const sqlite3 = await sqlite3InitModule();
line(`INFO init: sqlite3InitModule() from ./node_modules/@dolthub/doltlite-wasm/sqlite3.mjs → sqlite3 namespace, oo1 API present: ${!!sqlite3.oo1}`);
line(`INFO dolt_version (wasm): ${new sqlite3.oo1.DB('/version-probe.db').selectValue('SELECT dolt_version()')}`);
line(`INFO crossOriginIsolated: ${globalThis.crossOriginIsolated}`);
line(`INFO 'opfs' in sqlite3: ${'opfs' in sqlite3} (worker-thread VFS; cannot install on main thread per its feature check)`);

// Persistent VFS discovery: README's OpfsDb is the 'opfs' VFS = worker-only
// (requires Atomics.wait). The build also ships 'opfs-sahpool', installable
// on the main thread via sqlite3.installOpfsSAHPoolVfs() — discover it.
let persistVfs = null;
if (globalThis.crossOriginIsolated === true && sqlite3.installOpfsSAHPoolVfs) {
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs();
    persistVfs = pool.vfsName ?? 'opfs-sahpool';
    line(`INFO persistence: installOpfsSAHPoolVfs() OK → main-thread persistent VFS '${persistVfs}' available`);
  } catch (e) {
    line(`INFO persistence: installOpfsSAHPoolVfs() FAILED: ${e.message}`);
  }
}

// ---- PERSIST probe: set marker, reload once, verify survival on reloaded run
const params = new URLSearchParams(location.search);
if (persistVfs && !params.has('reloaded')) {
  const pdb = new sqlite3.oo1.DB('/lite-persist-probe.db', 'c', persistVfs);
  pdb.exec('CREATE TABLE IF NOT EXISTS marker(k TEXT PRIMARY KEY, v TEXT)');
  pdb.exec(`INSERT OR REPLACE INTO marker VALUES('alive','yes')`);
  pdb.exec(`SELECT dolt_commit('-A','-m','persist probe')`);
  pdb.close();
  location.search = '?reloaded=1';
} else {
  if (persistVfs) {
    const pdb = new sqlite3.oo1.DB('/lite-persist-probe.db', 'c', persistVfs);
    const v = pdb.selectValue(`SELECT v FROM marker WHERE k='alive'`);
    const n = pdb.selectValue(`SELECT COUNT(*) FROM dolt_log`);
    line(`PERSIST: ${v === 'yes' ? 'yes' : 'no'} (vfs=${persistVfs}; marker row ${v === 'yes' ? 'survived' : 'MISSING'} reload; dolt_log rows=${n})`);
    pdb.close();
  } else {
    line(`PERSIST: no (no persistent VFS: 'opfs' in sqlite3=${'opfs' in sqlite3} [worker-only], opfs-sahpool install failed, crossOriginIsolated=${globalThis.crossOriginIsolated})`);
  }

  let pass = 0;

  // ---- WS1 (≈LS1) basics -------------------------------------------------
  try {
    const db = new sqlite3.oo1.DB('/ws1.db');
    config(db);
    db.exec(SCHEMA);
    db.exec(`INSERT INTO events VALUES ('$ws1e1','m.room.message',NULL,'@poc:local',1000,'{"type":"m.room.message","content":{"body":"hello wasm"}}')`);
    db.exec(`INSERT INTO state VALUES ('m.room.topic','','$ws1e1','{"topic":"wasm"}')`);
    const h = db.selectValue(`SELECT dolt_commit('-Am','ws1')`);
    if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`bad commit hash: ${h}`);
    const msg = db.selectValue(`SELECT message FROM dolt_log LIMIT 1`);  // dolt_log default order = newest-first (L0)
    if (msg !== 'ws1') throw new Error(`dolt_log newest = ${msg}`);
    const v = db.selectValue(`SELECT dolt_version()`);
    const jt = db.selectValue(`SELECT json_extract(canonical_json,'$.type') FROM events`);
    if (jt !== 'm.room.message') throw new Error(`json_extract = ${jt}`);
    const committer = db.selectValue(`SELECT committer FROM dolt_log LIMIT 1`);
    line(`WS1: PASS (commit ${h}, version ${v}, json ok; committer='${committer}' — per-connection dolt_config held)`);
    pass++;
    db.close();
  } catch (e) { line(`WS1: FAIL — ${e.message}`); }

  // ---- WS3 (≈LS3) merge driver -------------------------------------------
  try {
    const db = new sqlite3.oo1.DB('/ws3.db');
    config(db);
    db.exec(SCHEMA);
    db.exec(`INSERT INTO state VALUES ('m.room.topic','','$base','origin')`);
    db.exec(`SELECT dolt_commit('-Am','ws3 base')`);
    db.exec(`SELECT dolt_branch('ma')`);
    db.exec(`SELECT dolt_branch('mb')`);
    db.exec(`SELECT dolt_checkout('ma')`);
    db.exec(`UPDATE state SET content='cats', event_id='$ma1' WHERE type='m.room.topic'`);
    db.exec(`SELECT dolt_commit('-Am','cats')`);
    db.exec(`SELECT dolt_checkout('mb')`);
    db.exec(`UPDATE state SET content='dogs', event_id='$mb1' WHERE type='m.room.topic'`);
    db.exec(`SELECT dolt_commit('-Am','dogs')`);
    db.exec(`SELECT dolt_checkout('ma')`);

    // negative control (autocommit)
    let negMsg = '';
    try { db.exec(`SELECT dolt_merge('mb')`); } catch (e) { negMsg = e.message; }
    const afterNeg = db.selectValue(`SELECT content FROM state WHERE type='m.room.topic'`);
    if (afterNeg !== 'cats') throw new Error(`negative control mutated state: ${afterNeg}`);
    line(`INFO ws3 negative control verbatim: ${negMsg}`);

    // explicit transaction (L0-recorded ordering: dolt_commit INSIDE the txn)
    db.exec('BEGIN');
    let mergeMsg = '';
    try { db.exec(`SELECT dolt_merge('mb')`); } catch (e) { mergeMsg = e.message; }
    const conflicts = db.selectObjects(`SELECT * FROM dolt_conflicts`);
    if (conflicts.length !== 1 || conflicts[0].table !== 'state' || Number(conflicts[0].num_conflicts) !== 1) {
      throw new Error(`dolt_conflicts: ${JSON.stringify(conflicts)}`);
    }
    const detail = db.selectObjects(`SELECT * FROM dolt_conflicts_state`);
    line(`INFO ws3 merge error-line: ${mergeMsg || '(none)'}; dolt_conflicts_state columns: ${Object.keys(detail[0]).join('|')}`);
    db.exec(`SELECT dolt_conflicts_resolve('--ours','state')`);
    db.exec(`UPDATE state SET content='DRIVER-DECIDED' WHERE type='m.room.topic'`);
    const guard = db.selectValue(`SELECT COUNT(*) FROM dolt_conflicts`);
    if (Number(guard) !== 0) throw new Error(`GUARD: ${guard} conflicts remain`);
    const mergeHash = db.selectValue(`SELECT dolt_commit('-Am','ws3 merge with driver content')`);
    let commitMsg = '';
    try { db.exec('COMMIT'); } catch (e) { commitMsg = e.message; }
    line(`INFO ws3 txn ordering: dolt_commit inside txn → ${mergeHash}; trailing COMMIT → ${commitMsg || 'ok'}`);

    const live = db.selectValue(`SELECT content FROM state WHERE type='m.room.topic'`);
    if (live !== 'DRIVER-DECIDED') throw new Error(`live content = ${live}`);
    const asof = db.selectValue(`SELECT content FROM dolt_at_state(dolt_hashof('ma')) WHERE type='m.room.topic'`);
    if (asof !== 'DRIVER-DECIDED') throw new Error(`dolt_at_state content = ${asof}`);
    const logs = db.selectObjects(`SELECT message FROM dolt_log`).map((r) => r.message);
    if (!logs.includes('cats') || !logs.includes('dogs')) throw new Error(`2-parent reachability missing: ${logs}`);
    line(`WS3: PASS (merge ${mergeHash}; live+at_state=DRIVER-DECIDED; dolt_log has cats+dogs)`);
    pass++;
    db.close();
  } catch (e) { line(`WS3: FAIL — ${e.message}`); }

  // ---- WS4 (≈LS4) branch-first ingest ------------------------------------
  let h0; let h1;
  try {
    const db = new sqlite3.oo1.DB('/ws4.db');
    config(db);
    db.exec(SCHEMA);
    db.exec(`INSERT INTO events VALUES ('$ws4gen','m.room.create',NULL,'@poc:local',4000,'{"type":"m.room.create"}')`);
    db.exec(`SELECT dolt_commit('-Am','ws4 genesis')`);
    h0 = db.selectValue(`SELECT dolt_hashof('main')`);
    db.exec(`SELECT dolt_branch('xevt')`);
    db.exec(`SELECT dolt_checkout('xevt')`);
    db.exec(`INSERT INTO events VALUES ('$ws4e1','m.room.message',NULL,'@poc:local',4001,'{"type":"m.room.message"}')`);
    db.exec(`INSERT OR REPLACE INTO state VALUES ('m.room.topic','','$ws4e1','{"topic":"bf"}')`);
    db.exec(`SELECT dolt_commit('-Am','ws4 event 1')`);
    h1 = db.selectValue(`SELECT dolt_hashof('xevt')`);
    const hm = db.selectValue(`SELECT dolt_hashof('main')`);
    if (hm !== h0) throw new Error(`main moved: ${h0} → ${hm}`);
    const diff = db.selectObjects(`SELECT diff_type FROM dolt_diff_events('HEAD~1','HEAD')`);
    if (diff.length !== 1 || diff[0].diff_type !== 'added') throw new Error(`diff rows: ${JSON.stringify(diff)}`);
    line(`WS4: PASS (branch-first commit ${h1}; main unmoved ${h0}; dolt_diff_events(HEAD~1,HEAD)=1 added row)`);
    pass++;

    // ---- WS5 (≈LS5) time travel (reuses WS4's db, like LS5 reuses LS4's) --
    try {
      const at = db.selectObjects(`SELECT * FROM dolt_at_events('${h0}')`);
      if (at.length !== 1 || at[0].event_id !== '$ws4gen') throw new Error(`dolt_at_events(h0): ${JSON.stringify(at)}`);
      const hist = db.selectValue(`SELECT COUNT(*) FROM dolt_history_events`);
      if (Number(hist) < 2) throw new Error(`dolt_history_events rows = ${hist}`);
      const d2 = db.selectObjects(`SELECT diff_type FROM dolt_diff_events('${h0}','${h1}')`);
      if (d2.length < 1) throw new Error('dolt_diff_events(h0,h1) empty');
      const hd = db.selectValue(`SELECT dolt_hashof_db()`);
      if (!/^[0-9a-f]{40}$/.test(hd)) throw new Error(`dolt_hashof_db = ${hd}`);
      line(`WS5: PASS (at_events=1 row; history_events=${hist} rows; diff(h0,h1)=${d2.length} row; hashof_db=${hd})`);
      pass++;
    } catch (e) { line(`WS5: FAIL — ${e.message}`); }
    db.close();
  } catch (e) { line(`WS4: FAIL — ${e.message}`); line('WS5: SKIP — WS4 db unavailable'); }

  // ---- PERF: 100 sequential event-commits (in-memory) ---------------------
  try {
    const db = new sqlite3.oo1.DB('/wsperf.db');
    config(db);
    db.exec(SCHEMA);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      db.exec(`INSERT INTO events VALUES ('$perf${i}','m.room.message',NULL,'@poc:local',${5000 + i},'{"type":"m.room.message","content":{"body":"perf ${i}"}}')`);
      db.exec(`SELECT dolt_commit('-Am','perf ${i}')`);
    }
    const ms = Math.round(performance.now() - t0);
    const committer = db.selectValue(`SELECT committer FROM dolt_log LIMIT 1`);
    line(`PERF: 100 commits in ${ms} ms (in-memory; committer column on same connection = '${committer}')`);
    db.close();
  } catch (e) { line(`PERF: ERROR — ${e.message}`); }

  // ---- branch-qualified open probe (CLI form '<file>@<branch>') ----------
  // Runs AFTER the spikes on purpose: bisection (probe.js) proved that in
  // this build a '<file>@<branch>' open poisons the NEXT dolt_commit on ANY
  // connection with a one-shot "commit conflict" error.
  {
    const f1 = new sqlite3.oo1.DB('/wbt.db');
    f1.exec(`CREATE TABLE t(x)`);
    f1.exec(`SELECT dolt_branch('b1')`);
    f1.close();
    try {
      const f2 = new sqlite3.oo1.DB('/wbt.db@b1');
      const ab = f2.selectValue('SELECT active_branch()');
      f2.close();
      let side = 'no side effect observed';
      try {
        const s = new sqlite3.oo1.DB('/wbt-side.db');
        s.exec(`CREATE TABLE t(x)`);
        s.exec(`INSERT INTO t VALUES (1)`);
        s.exec(`SELECT dolt_commit('-Am','sacrificial')`);
      } catch (e2) {
        side = `SIDE EFFECT: next dolt_commit (any file) failed once: ${e2.message}`;
        const s2 = new sqlite3.oo1.DB('/wbt-side2.db');
        s2.exec(`CREATE TABLE t(x)`);
        try {
          s2.exec(`SELECT dolt_commit('-Am','after poison')`);
          side += `; following commit succeeded (one-shot)`;
        } catch (e3) { side += `; following commit ALSO failed: ${e3.message}`; }
      }
      line(`INFO wasm branch-open: '<db>@<branch>' filename works → active_branch()='${ab}'. ${side}`);
    } catch (e) {
      line(`INFO wasm branch-open: '<db>@<branch>' filename FAILED (${e.message}) — dolt_checkout used instead`);
    }
  }

  line(`WASM SPIKES: ${pass}/4 PASS`);
}
