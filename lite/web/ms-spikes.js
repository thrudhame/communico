// MS0 — keystone spikes for matrix-sync (phase-ms0.md):
//   vectors — canonical/eventid port fidelity (server test vectors)
//   S-branch — hang an event on an INTERIOR commit (THE GATE)
//   S-det    — deterministic table-level convergence across arrival orders
//   S-union  — union timeline across forked extremities
// One page, in-page stores, no transport. Standing WASM rules honored:
// one long-lived connection per store; no '<file>@<branch>' opens;
// dolt_checkout on the connection; per-connection dolt_config; retry-once
// commit (recorded poison rule); dolt_log default order; COUNT(*) checks.
import sqlite3InitModule from './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs';
import { canonicalJson } from './sync/canonical.js';
import { redact, eventIdFor } from './sync/eventid.js';

const out = document.querySelector('#results');
out.textContent = '';
const line = (s) => { out.textContent += s + '\n'; };

const sqlite3 = await sqlite3InitModule();

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

// retry-once commit (poison rule — working state survives a refused commit,
// so retry ONLY the commit statement; recorded in the L1/LP findings)
function commitRobust(db, msg) {
  try {
    return db.selectValue(`SELECT dolt_commit('-Am','${msg}')`);
  } catch (e) {
    if (e.message.includes('commit conflict: another connection committed')) {
      return db.selectValue(`SELECT dolt_commit('-Am','${msg}')`);
    }
    throw e;
  }
}

function mkStore(path, user) {
  const db = new sqlite3.oo1.DB(path);
  db.exec(`SELECT dolt_config('user.name','${user}')`);
  db.exec(`SELECT dolt_config('user.email','${user}')`);
  db.exec(SCHEMA);
  commitRobust(db, 'schema genesis');
  return db;
}

// ---- minimal branch-first engine (MS0 spike form; MS1 turns this into
// engine-lite's real rework) -----------------------------------------------
function newEngineState() {
  return {
    seq: 0,                 // branch counter
    idx: new Map(),         // eventId → {hash, branch, alive}
    tips: [],               // live extremity branch names
    sbranchNotes: [],
  };
}

async function makePdu(evt) {
  const pdu = {
    type: evt.type, room_id: evt.room_id ?? '!ms0:local', sender: evt.sender,
    content: evt.content, prev_events: evt.prev_events,
    origin_server_ts: evt.origin_server_ts, depth: 0,
  };
  if (evt.state_key !== undefined) pdu.state_key = evt.state_key;
  pdu.event_id = await eventIdFor(pdu);
  return pdu;
}

// RECORDED ROUTE per the S-branch spike: dolt_branch('<name>','<start
// commit hash>') — branch AT an interior commit (undocumented in the
// DoltLite README; natively verified during probing, spike re-verifies).
function branchAtCommit(db, name, commitHash) {
  db.exec(`SELECT dolt_branch('${name}','${commitHash}')`);
}

function ingest(db, st, pdu) {
  const prevs = pdu.prev_events ?? [];
  if (prevs.length > 2) throw new Error('M_TOO_MANY_PREV_EVENTS');
  st.seq++;
  const branch = 'x' + st.seq;

  // D8 branch-first: land on prev0's tip (live branch, else re-materialize
  // one AT the prev's commit via the recorded route), then create+switch to
  // the new extremity branch BEFORE any merge or write.
  let baseBranch = 'main';
  if (prevs.length > 0) {
    const p0 = st.idx.get(prevs[0]);
    if (!p0) throw new Error(`unknown prev ${prevs[0]}`);
    if (p0.alive) {
      baseBranch = p0.branch;
    } else {
      const holder = `h${st.seq}`;
      branchAtCommit(db, holder, p0.hash);
      st.sbranchNotes.push(`created '${holder}' at interior commit ${p0.hash.slice(0, 8)} for prev ${prevs[0].slice(0, 9)}…`);
      baseBranch = holder;
    }
  }
  db.exec(`SELECT dolt_checkout('${baseBranch}')`);
  db.exec(`SELECT dolt_checkout('-b','${branch}')`);

  const doInsert = () => {
    db.exec({
      sql: `INSERT INTO events VALUES (?,?,?,?,?,?)`,
      bind: [pdu.event_id, pdu.type, pdu.state_key ?? null, pdu.sender, pdu.origin_server_ts, canonicalJson(pdu)],
    });
    if (pdu.state_key != null) {
      db.exec({
        sql: `INSERT OR REPLACE INTO state VALUES (?,?,?,?)`,
        bind: [pdu.type, pdu.state_key, pdu.event_id, canonicalJson(pdu)],
      });
    }
  };

  if (prevs.length === 2) {
    // recorded LS3/WS3 driver sequence; dolt_commit INSIDE the txn (L0
    // finding: dolt_commit finalizes the txn itself; trailing COMMIT
    // intentionally omitted — recorded choice)
    const p1 = st.idx.get(prevs[1]);
    if (!p1) throw new Error(`unknown prev ${prevs[1]}`);
    let other = p1.branch;
    if (!p1.alive) {
      const holder = `h${st.seq}m`;
      branchAtCommit(db, holder, p1.hash);
      st.sbranchNotes.push(`merge-side holder '${holder}' at interior commit ${p1.hash.slice(0, 8)}`);
      other = holder;
    }
    db.exec('BEGIN');
    try {
      try { db.exec(`SELECT dolt_merge('${other}')`); }
      catch (e) { if (!/conflict/i.test(e.message)) throw e; }
      const conflicts = db.selectObjects(`SELECT * FROM dolt_conflicts`);
      for (const c of conflicts) {
        if (c.table === 'events') throw new Error('E_EVENTS_CONFLICT');
        if (c.table !== 'state') throw new Error(`unexpected conflict table ${c.table}`);
      }
      if (conflicts.length) {
        const rows = db.selectObjects(`SELECT * FROM dolt_conflicts_state`);
        db.exec(`SELECT dolt_conflicts_resolve('--ours','state')`);
        for (const r of rows) {
          const ourE = db.selectObject(`SELECT origin_ts, event_id FROM events WHERE event_id = ?`, [r.our_event_id]);
          const theirE = db.selectObject(`SELECT origin_ts, event_id FROM events WHERE event_id = ?`, [r.their_event_id]);
          const theirsWins = theirE && (!ourE || theirE.origin_ts > ourE.origin_ts ||
            (theirE.origin_ts === ourE.origin_ts && theirE.event_id > ourE.event_id));
          db.exec({
            sql: `UPDATE state SET content = ?, event_id = ? WHERE type = ? AND state_key = ?`,
            bind: [theirsWins ? r.their_content : r.our_content,
                   theirsWins ? r.their_event_id : r.our_event_id,
                   r.our_type ?? r.their_type, r.our_state_key ?? r.their_state_key],
          });
        }
      }
      const guard = db.selectValue(`SELECT COUNT(*) AS n FROM dolt_conflicts`);
      if (Number(guard) !== 0) throw new Error(`E_CONFLICT_GUARD: ${guard}`);
      doInsert();
      commitRobust(db, `event ${pdu.event_id.slice(0, 9)} type ${pdu.type} (merge)`);
      try { db.exec('COMMIT'); } catch { /* dolt_commit finalized the txn (recorded) */ }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already finalized */ }
      throw e;
    }
  } else {
    doInsert();
    commitRobust(db, `event ${pdu.event_id.slice(0, 9)} type ${pdu.type}`);
  }

  const hash = db.selectValue(`SELECT dolt_hashof('${branch}')`);
  // consume prev extremity branches whose branch is alive and now an ancestor
  for (const p of prevs) {
    const pe = st.idx.get(p);
    if (pe?.alive) {
      db.exec(`SELECT dolt_branch('-D','${pe.branch}')`);
      pe.alive = false;
      st.tips = st.tips.filter((t) => t !== pe.branch);
    }
  }
  st.idx.set(pdu.event_id, { hash, branch, alive: true });
  st.tips.push(branch);
  return { event_id: pdu.event_id, hash, branch };
}

// ---- spike: identity vectors (server test vectors, verbatim semantics) ----
async function runVectors() {
  const PDU = {
    type: 'm.room.message', room_id: '!r:localhost', sender: '@dev:localhost',
    content: { body: 'hello', msgtype: 'm.text' }, prev_events: ['$abc'],
    origin_server_ts: 1000, depth: 0,
  };
  const cj = canonicalJson({ b: 2, a: { d: [4, { z: 1, y: 2 }], c: 3 } });
  if (cj !== '{"a":{"c":3,"d":[4,{"y":2,"z":1}]},"b":2}') throw new Error('sorted-keys vector mismatch: ' + cj);
  const id = await eventIdFor(PDU);
  if (!/^\$[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('bad id shape: ' + id);
  if (await eventIdFor(PDU) !== await eventIdFor({ ...PDU })) throw new Error('not deterministic');
  const other = await eventIdFor({ ...PDU, content: { body: 'completely different', msgtype: 'm.image' } });
  if (other !== id) throw new Error('redacted-content invariance violated');
  const s2 = await eventIdFor({ ...PDU, sender: '@other:localhost' });
  if (s2 === id) throw new Error('sender sensitivity violated');
  const rm = redact({ type: 'm.room.member', sender: '@a:b', state_key: '@c:d', content: { membership: 'join', displayname: 'X', avatar_url: 'mxc://y' } });
  if (JSON.stringify(rm.content) !== '{"membership":"join"}') throw new Error('member redact mismatch');
  const content = { creator: '@a:b', room_version: '10', extra: true };
  const rc = redact({ type: 'm.room.create', sender: '@a:b', content });
  if (JSON.stringify(rc.content) !== JSON.stringify(content)) throw new Error('create redact mismatch');
  line(`MS0-VECTORS: PASS (canonical sorted-keys vector exact; id shape/determinism/redaction-invariance/sender-sensitivity; member+create redaction) — sample id ${id}`);
}

// ---- spike: S-branch (THE GATE) ----
async function runSBranch() {
  const db = mkStore('/ms0-s1.db', 's1');
  const st = newEngineState();
  const e1 = await makePdu({ type: 'm.room.message', sender: '@alice:browser', content: { body: 'e1', msgtype: 'm.text' }, prev_events: [], origin_server_ts: 1000 });
  const r1 = ingest(db, st, e1);
  const e2 = await makePdu({ type: 'm.room.message', sender: '@alice:browser', content: { body: 'e2', msgtype: 'm.text' }, prev_events: [e1.event_id], origin_server_ts: 1001 });
  const r2 = ingest(db, st, e2);   // consumes e1's branch x1 → x2
  // e1's branch is now GONE. Foreign fork event e2b (prev e1) arrives:
  const e1Commit = st.idx.get(e1.event_id).hash;
  line(`INFO s-branch: e1 branch x1 consumed+deleted; e1 commit ${e1Commit}; now hanging fork event e2b on it`);

  // The two candidate forms, recorded verbatim. Form 1 is tried first per
  // the phase; on success it is THE ROUTE. Form 2 also tried (informational).
  const notes = [];
  let route = null;
  try {
    db.exec(`SELECT dolt_branch('xf','${e1Commit}')`);
    const h = db.selectValue(`SELECT dolt_hashof('xf')`);
    notes.push(`form 1: SELECT dolt_branch('xf','<hash>') → 0; dolt_hashof('xf') = ${h} (${h === e1Commit ? 'AT the interior commit ✓' : 'MISMATCH!'})`);
    route = `dolt_branch('<name>','<start-commit-hash>')`;
  } catch (e) {
    notes.push(`form 1 FAILED verbatim: ${e.message}`);
  }
  try {
    db.exec(`SELECT dolt_checkout('-b','xf2','${e1Commit}')`);
    const ab = db.selectValue(`SELECT active_branch()`);
    const h2 = db.selectValue(`SELECT dolt_hashof('xf2')`);
    notes.push(`form 2 (informational): dolt_checkout('-b','xf2','<hash>') → 0; active_branch()=${ab}; hashof=${h2 === e1Commit ? 'AT the interior commit ✓' : h2}`);
    db.exec(`SELECT dolt_checkout('main')`);
    db.exec(`SELECT dolt_branch('-D','xf2')`);
  } catch (e) {
    notes.push(`form 2 (informational) FAILED verbatim: ${e.message}`);
  }
  for (const n of notes) line('INFO s-branch: ' + n);
  if (!route) {
    line('MS0-SBRANCH: FAIL — both start-point forms failed; fallback F2 (branch-per-event retention) is required');
    return { pass: false, route: null };
  }

  // the gate's actual proof: ingest e2b with prev e1 via the recorded route
  const e2b = await makePdu({ type: 'm.room.message', sender: '@bob:browser', content: { body: 'e2b fork', msgtype: 'm.text' }, prev_events: [e1.event_id], origin_server_ts: 1002 });
  const rb = ingest(db, st, e2b);
  if (st.sbranchNotes.length === 0) throw new Error('S-branch route was NOT exercised (no note)');
  for (const n of st.sbranchNotes) line('INFO s-branch: ' + n);

  // assert two extremities, each tip's dolt_at_events shows its lineage
  const tips = st.tips;
  if (tips.length !== 2) throw new Error(`expected 2 extremities, got ${tips.length}: ${tips}`);
  const atA = db.selectObjects(`SELECT event_id FROM dolt_at_events('${st.idx.get(e2.event_id).hash}')`).map((r) => r.event_id);
  const atB = db.selectObjects(`SELECT event_id FROM dolt_at_events('${st.idx.get(e2b.event_id).hash}')`).map((r) => r.event_id);
  if (!(atA.includes(e1.event_id) && atA.includes(e2.event_id) && !atA.includes(e2b.event_id))) {
    throw new Error(`x2 lineage wrong: ${atA}`);
  }
  if (!(atB.includes(e1.event_id) && atB.includes(e2b.event_id) && !atB.includes(e2.event_id))) {
    throw new Error(`xf lineage wrong: ${atB}`);
  }
  line(`MS0-SBRANCH: PASS (route: ${route}; two extremities x2+xf with correct per-tip lineage; the e1-commit holder branch persists as the fork base)`);
  return { pass: true, route };
}

// ---- spike: S-det — deterministic table-level convergence (THE PROOF) ----
async function buildFixture() {
  const evts = {};
  const add = async (name, partial) => { evts[name] = await makePdu(partial); return evts[name]; };
  const e0 = await add('e0', { type: 'm.room.create', state_key: '', sender: '@alice:browser', content: { creator: '@alice:browser', room_version: 'lite.1' }, prev_events: [], origin_server_ts: 2000 });
  const e1 = await add('e1', { type: 'm.room.member', state_key: '@alice:browser', sender: '@alice:browser', content: { membership: 'join', displayname: 'alice' }, prev_events: [e0.event_id], origin_server_ts: 2001 });
  const e2 = await add('e2', { type: 'm.room.message', sender: '@alice:browser', content: { body: 'm2', msgtype: 'm.text' }, prev_events: [e1.event_id], origin_server_ts: 2002 });
  const e3a = await add('e3a', { type: 'm.room.message', sender: '@alice:browser', content: { body: 'm3a', msgtype: 'm.text' }, prev_events: [e2.event_id], origin_server_ts: 3000 });
  const e3b = await add('e3b', { type: 'm.room.message', sender: '@bob:browser', content: { body: 'm3b', msgtype: 'm.text' }, prev_events: [e2.event_id], origin_server_ts: 3001 });
  const e4 = await add('e4', { type: 'm.room.message', sender: '@alice:browser', content: { body: 'm4 heal', msgtype: 'm.text' }, prev_events: [e3a.event_id, e3b.event_id], origin_server_ts: 3003 });
  const e5 = await add('e5', { type: 'm.room.message', sender: '@bob:browser', content: { body: 'm5', msgtype: 'm.text' }, prev_events: [e4.event_id], origin_server_ts: 3004 });
  return evts;
}

async function runSDet() {
  const fx = await buildFixture();
  const orderA = ['e0', 'e1', 'e2', 'e3a', 'e3b', 'e4', 'e5'];
  const orderB = ['e0', 'e1', 'e2', 'e3b', 'e3a', 'e4', 'e5']; // different topo-valid arrival order
  const stores = {};
  for (const [name, order] of [['A', orderA], ['B', orderB]]) {
    const db = mkStore(`/ms0-sdet-${name}.db`, 'sdet-' + name); // per-store committer → honest divergence
    const st = newEngineState();
    for (const k of order) ingest(db, st, fx[k]);
    stores[name] = { db, st };
  }
  const hashOf = (db, t) => db.selectValue(`SELECT dolt_hashof_table('${t}')`);
  const evA = hashOf(stores.A.db, 'events'); const evB = hashOf(stores.B.db, 'events');
  const stA = hashOf(stores.A.db, 'state'); const stB = hashOf(stores.B.db, 'state');
  line(`INFO s-det: events table hash A=${evA} B=${evB} (${evA === evB ? 'EQUAL' : 'DIFFER'})`);
  line(`INFO s-det: state  table hash A=${stA} B=${stB} (${stA === stB ? 'EQUAL' : 'DIFFER'})`);
  if (evA !== evB || stA !== stB) throw new Error('table hashes differ across arrival orders');
  const stateRows = (db) => db.selectObjects(`SELECT * FROM state ORDER BY type, state_key`).map((r) => JSON.stringify(r)).join(';');
  if (stateRows(stores.A.db) !== stateRows(stores.B.db)) throw new Error('state row content differs');
  const dbHashA = stores.A.db.selectValue(`SELECT dolt_hashof_db()`);
  const dbHashB = stores.B.db.selectValue(`SELECT dolt_hashof_db()`);
  // Per-replica divergence proof: the same logical event's COMMIT hash must
  // differ across stores (per-store committer). dolt_hashof_db is recorded
  // as CONTENT-KEYED (does NOT include the commit graph — verified natively
  // too: different commit messages/committers, equal content ⇒ equal
  // hashof_db; commit hashes differ), so equality here is expected and the
  // divergence claim is carried by the per-event commit hashes.
  const tipCommitA = stores.A.st.idx.get(fx.e5.event_id).hash;
  const tipCommitB = stores.B.st.idx.get(fx.e5.event_id).hash;
  if (tipCommitA === tipCommitB) throw new Error('per-replica commit hashes should differ (same logical event, different committer)');
  line(`INFO s-det: e5's commit hash A=${tipCommitA.slice(0, 12)} B=${tipCommitB.slice(0, 12)} (DIFFER ✓ — per-replica commit graphs diverge by design; convergence proof lives at table level)`);
  line(`INFO s-det: dolt_hashof_db A=${dbHashA.slice(0, 12)} B=${dbHashB.slice(0, 12)} (${dbHashA === dbHashB ? 'EQUAL — recorded finding: hashof_db is CONTENT-keyed (commit graph NOT included); verified natively too' : 'DIFFER (unexpected — investigate)'})`);
  if (dbHashA !== dbHashB) throw new Error('dolt_hashof_db differed despite equal content — content-keyed finding broken?');
  // e4 2-parent reachability on each store's tip: dolt_log (default order)
  // must contain BOTH fork events' commit messages (ids embedded)
  for (const name of ['A', 'B']) {
    const msgs = stores[name].db.selectObjects(`SELECT message FROM dolt_log`).map((r) => r.message).join('\n');
    const a = fx.e3a.event_id.slice(0, 9); const b = fx.e3b.event_id.slice(0, 9);
    if (!(msgs.includes(a) && msgs.includes(b))) throw new Error(`store ${name}: heal commit lineage missing e3a/e3b`);
  }
  line(`INFO s-det: both stores' tip dolt_log reach both fork commits (2-parent heal verified)`);
  line(`MS0-SDET: PASS (ev ${evA.slice(0, 8)} st ${stA.slice(0, 8)} — equal across both arrival orders; 7 events incl. fork+heal)`);
  return true;
}

// ---- spike: S-union — forked timeline union ----
async function runSUnion() {
  const fx = await buildFixture();
  const db = mkStore('/ms0-sunion.db', 'sunion');
  const st = newEngineState();
  for (const k of ['e0', 'e1', 'e2', 'e3a', 'e3b']) ingest(db, st, fx[k]);
  if (st.tips.length !== 2) throw new Error(`expected 2 live tips at the forked moment, got ${st.tips.length}`);
  const tipHashes = st.tips.map((b) => db.selectValue(`SELECT dolt_hashof('${b}')`));
  const seen = new Map();
  for (const h of tipHashes) {
    for (const r of db.selectObjects(`SELECT event_id, origin_ts FROM dolt_at_events('${h}')`)) {
      if (!seen.has(r.event_id)) seen.set(r.event_id, r.origin_ts);
    }
  }
  const union = [...seen.entries()].map(([event_id, origin_ts]) => ({ event_id, origin_ts }))
    .sort((a, b) => a.origin_ts - b.origin_ts || (a.event_id < b.event_id ? -1 : 1));
  const bodies = union.map((e) => e.event_id);
  const want = [fx.e0, fx.e1, fx.e2, fx.e3a, fx.e3b].map((p) => p.event_id);
  const countsOk = want.every((id) => bodies.filter((b) => b === id).length === 1);
  if (!countsOk || union.length !== 5) throw new Error(`union wrong: ${bodies.length} rows, countsOk=${countsOk}`);
  line(`MS0-SUNION: PASS (union across 2 extremity tips: e0,e1,e2,e3a,e3b each exactly once, ordered by (origin_ts,event_id); e2 NOT duplicated)`);
  return true;
}

// ---- driver ----
let pass = 0;
let vectorsOk = false;
try { await runVectors(); vectorsOk = true; } catch (e) { line(`MS0-VECTORS: FAIL — ${e.message}`); }
try { const r = await runSBranch(); if (r.pass) pass++; } catch (e) { line(`MS0-SBRANCH: FAIL — ${e.message}`); }
if (vectorsOk) {
  try { if (await runSDet()) pass++; } catch (e) { line(`MS0-SDET: FAIL — ${e.message}`); }
  try { if (await runSUnion()) pass++; } catch (e) { line(`MS0-SUNION: FAIL — ${e.message}`); }
} else {
  line('MS0-SDET: SKIP — identity vectors failed'); line('MS0-SUNION: SKIP');
}
line(`MS0: ${pass}/3 PASS${vectorsOk ? '' : ' (vectors FAILED)'}`);
