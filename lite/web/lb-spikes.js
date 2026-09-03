// LB — dolt-native sync spikes (lite-v1 plan Phase B; the LP2b revival on
// wasm 0.50.3, now that upstream #2573+#2576 landed):
//   LB1 — file:// remote + dolt_fetch keystone (PB2's failing case) +
//         in-place peer-file update → second fetch must see new commits
//   LB2 — fork + heal: divergent commits, symmetric fetch + LS3 driver merge,
//         converge to equal dolt_hashof_table('events')/('state')
//   LB3 — late-peer: bootstrap from bytes, then catch up via fetch + ff merge
//   LB4 — 10-generation longevity on the REMOTE path (#2568 regression watch)
// Spike-local machinery inlined (self-contained per the LP precedent).
// Spike replicas commit directly on main: remote/fetch/merge mechanics are
// the subject here; the engine's branch-first extremity dance is orthogonal
// (engine mapping is recorded in RESULTS).
import sqlite3InitModule from './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs';

const out = document.querySelector('#results');
out.textContent = '';
const line = (s) => { out.textContent += s + '\n'; };

const sqlite3 = await sqlite3InitModule();
const capi = sqlite3.capi;

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

const exportDb = (db) => capi.sqlite3_js_db_export(db.pointer);

const mkReplica = (path, who) => {
  const db = new sqlite3.oo1.DB(path);
  db.exec(`SELECT dolt_config('user.name','${who}')`);
  db.exec(`SELECT dolt_config('user.email','${who}@localhost')`);
  db.exec(SCHEMA);
  db.selectValue(`SELECT dolt_commit('-Am','schema genesis')`);
  return db;
};
const commitEvent = (db, id, body, ts) => {
  const canon = JSON.stringify({ type: 'm.room.message', content: { body } });
  db.exec(`INSERT INTO events VALUES ('${id}','m.room.message',NULL,'@lb:local',${ts},'${canon}')`);
  return db.selectValue(`SELECT dolt_commit('-Am','event ${id}')`);
};
const setTopic = (db, content, eventId, ts) => {
  const canon = JSON.stringify({ type: 'm.room.topic', content: { topic: content } });
  db.exec(`INSERT INTO events VALUES ('${eventId}','m.room.topic','','@lb:local',${ts},'${canon}')`);
  db.exec(`INSERT OR REPLACE INTO state VALUES ('m.room.topic','','${eventId}','${content}')`);
  return db.selectValue(`SELECT dolt_commit('-Am','topic ${eventId}')`);
};

// --- remote plumbing: the peer's store lives as a MEMFS file that we update
// IN PLACE (vfs_create_file at a stable path) so dolt sees the remote change
// between fetches. Overwrite semantics of vfs_create_file are DISCOVERED
// here (undocumented) and recorded verbatim.
const peerFile = (name) => `/peer-${name}.db`;
const writePeerFile = (name, bytes) =>
  capi.sqlite3_js_vfs_create_file('unix', peerFile(name), bytes, bytes.byteLength);
const addRemote = (db, remote, peerName) =>
  db.exec(`SELECT dolt_remote('add','${remote}','file://${peerFile(peerName)}')`);

const tableHashes = (db) => ({
  events: db.selectValue(`SELECT dolt_hashof_table('events')`),
  state: db.selectValue(`SELECT dolt_hashof_table('state')`),
});

// LS3/WS3-recorded explicit-txn driver (latest-wins on state; events must
// never conflict). Caller wraps BEGIN..COMMIT; dolt_commit runs INSIDE.
function mergeDriver(db, otherRef) {
  try { db.exec(`SELECT dolt_merge('${otherRef}')`); }
  catch (e) { if (!/conflict/i.test(e.message)) throw e; }
  const conflicts = db.selectObjects(`SELECT * FROM dolt_conflicts`);
  for (const c of conflicts) {
    if (c.table === 'events') throw new Error('E_EVENTS_CONFLICT: events must never conflict');
    if (c.table !== 'state') throw new Error(`unexpected conflict table: ${c.table}`);
  }
  if (!conflicts.length) return 'clean';
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
  const guard = db.selectValue(`SELECT COUNT(*) FROM dolt_conflicts`);
  if (Number(guard) !== 0) throw new Error(`E_CONFLICT_GUARD: ${guard} conflicts remain`);
  return 'driver';
}

function healTxn(db, ref, tag) {
  db.exec('BEGIN');
  const how = mergeDriver(db, ref);
  let committed = null;
  try { committed = db.selectValue(`SELECT dolt_commit('-Am','heal ${tag}')`); }
  catch (e) { line(`INFO ${tag}: post-merge commit note: ${e.message.slice(0, 100)}`); }
  try { db.exec('COMMIT'); } catch { /* dolt_commit finalized the txn (recorded) */ }
  return { how, committed };
}

// ============================== LB1 ========================================
function lb1() {
  const A = mkReplica('/lb1-a.db', 'lb1a');
  commitEvent(A, '$lb1-a1', 'a1', 1001);
  const tipA1 = commitEvent(A, '$lb1-a2', 'a2', 1002);

  const B = mkReplica('/lb1-b.db', 'lb1b'); // own genesis; pure remote probe, never merges
  writePeerFile('lb1a', exportDb(A));
  addRemote(B, 'peerA', 'lb1a');
  let fetchRc;
  try {
    fetchRc = B.selectValue(`SELECT dolt_fetch('peerA')`);
  } catch (e) {
    line(`LB1: FAIL — dolt_fetch threw: ${e.message}  (PB2 ABI-crash class alive?)`);
    A.close(); B.close();
    return false;
  }
  line(`INFO lb1: dolt_fetch('peerA') rc=${fetchRc}`);
  const remotes = B.selectObjects(`SELECT * FROM dolt_remotes`);
  line(`INFO lb1: dolt_remotes = ${JSON.stringify(remotes)}`);
  const logs = B.selectObjects(`SELECT message FROM dolt_log('peerA/main')`).map((r) => r.message);
  line(`INFO lb1: dolt_log('peerA/main') messages = ${JSON.stringify(logs)}`);
  const hRemote = B.selectValue(`SELECT dolt_hashof('peerA/main')`);
  let hRemoteAlt = '(threw)';
  try { hRemoteAlt = B.selectValue(`SELECT dolt_hashof('remotes/peerA/main')`); }
  catch (e) { hRemoteAlt = `(threw: ${e.message.slice(0, 60)})`; }
  line(`INFO lb1: hashof('peerA/main')=${hRemote} hashof('remotes/peerA/main')=${hRemoteAlt} A tip=${tipA1}`);
  if (hRemote !== tipA1 || !logs.includes('event $lb1-a2')) {
    line(`LB1: FAIL — remote ref does not reflect A's store`);
    A.close(); B.close();
    return false;
  }

  // in-place update of the SAME peer file → second fetch must advance the ref
  const tipA2 = commitEvent(A, '$lb1-a3', 'a3', 1003);
  let overwriteNote = 'vfs_create_file over existing path: ok';
  try {
    writePeerFile('lb1a', exportDb(A));
  } catch (e) {
    overwriteNote = `vfs_create_file over existing path THREW: ${e.message}`;
  }
  line(`INFO lb1: ${overwriteNote}`);
  B.selectValue(`SELECT dolt_fetch('peerA')`);
  const hAfter = B.selectValue(`SELECT dolt_hashof('peerA/main')`);
  const sawA3 = B.selectObjects(`SELECT message FROM dolt_log('peerA/main')`).map((r) => r.message).includes('event $lb1-a3');
  line(`INFO lb1: after in-place update: peerA/main=${hAfter} (A tip ${tipA2}); log has a3=${sawA3}`);
  A.close(); B.close();
  if (hAfter !== tipA2 || !sawA3) {
    line(`LB1: FAIL — second fetch did not see the in-place update`);
    return false;
  }
  line(`LB1: PASS (dolt_remote add + dolt_fetch over file:// works in wasm 0.50.3; remote refs readable; in-place peer-file update → incremental fetch)`);
  return true;
}

// ============================== LB2 ========================================
function lb2() {
  const A = mkReplica('/lb2-a.db', 'lb2a');
  commitEvent(A, '$lb2-g1', 'shared genesis event', 2001);
  // B bootstraps from A's bytes as its OWN store (LP2a-proven form)
  const boot = exportDb(A);
  capi.sqlite3_js_vfs_create_file('unix', '/lb2-b-boot.db', boot, boot.byteLength);
  const B = new sqlite3.oo1.DB('/lb2-b-boot.db');
  B.exec(`SELECT dolt_config('user.name','lb2b')`);
  B.exec(`SELECT dolt_config('user.email','lb2b@localhost')`);

  // true fork: both commit distinct events AND conflicting state (topic);
  // B's topic has the later origin_ts → the driver picks 'topic-by-B' on both sides
  commitEvent(A, '$lb2-a-fork', 'fork from a', 2010);
  setTopic(A, 'topic-by-A', '$lb2-ta', 2011);
  commitEvent(B, '$lb2-b-fork', 'fork from b', 2012);
  setTopic(B, 'topic-by-B', '$lb2-tb', 2013);

  // symmetric ship over remote files
  writePeerFile('lb2a', exportDb(A)); addRemote(B, 'peerA', 'lb2a');
  writePeerFile('lb2b', exportDb(B)); addRemote(A, 'peerB', 'lb2b');
  B.selectValue(`SELECT dolt_fetch('peerA')`);
  A.selectValue(`SELECT dolt_fetch('peerB')`);

  const healB = healTxn(B, 'peerA/main', 'lb2-B');
  const healA = healTxn(A, 'peerB/main', 'lb2-A');
  line(`INFO lb2: heal B←peerA/main: ${healB.how} (commit ${healA ? '' : ''}${healB.committed?.slice(0, 8) ?? 'none'}); heal A←peerB/main: ${healA.how} (commit ${healA.committed?.slice(0, 8) ?? 'none'})`);

  const hA = tableHashes(A); const hB = tableHashes(B);
  const topicA = A.selectValue(`SELECT content FROM state WHERE type='m.room.topic'`);
  const topicB = B.selectValue(`SELECT content FROM state WHERE type='m.room.topic'`);
  const seeA = Number(B.selectValue(`SELECT COUNT(*) FROM events WHERE canonical_json LIKE '%fork from a%'`)) === 1;
  const seeB = Number(A.selectValue(`SELECT COUNT(*) FROM events WHERE canonical_json LIKE '%fork from b%'`)) === 1;
  const dbA = A.selectValue(`SELECT dolt_hashof_db()`);
  const dbB = B.selectValue(`SELECT dolt_hashof_db()`);
  line(`INFO lb2: dolt_hashof_db A=${dbA.slice(0, 12)} B=${dbB.slice(0, 12)} (tracks working-set content, not refs — merge commits differ, hash still equal; the table hashes are the certificate)`);
  A.close(); B.close();
  if (hA.events === hB.events && hA.state === hB.state && topicA === 'topic-by-B' && topicB === 'topic-by-B' && seeA && seeB) {
    line(`LB2: PASS (fork healed via fetch + driver merge both directions; events ${hA.events.slice(0, 8)}== state ${hA.state.slice(0, 8)}==; topic='${topicA}' both sides)`);
    return true;
  }
  line(`LB2: FAIL — events ${hA.events}/${hB.events} state ${hA.state}/${hB.state} topics '${topicA}'/'${topicB}' seeA=${seeA} seeB=${seeB}`);
  return false;
}

// ============================== LB3 ========================================
function lb3() {
  const A = mkReplica('/lb3-a.db', 'lb3a');
  commitEvent(A, '$lb3-a1', 'before join', 3001);
  // C (late peer) bootstraps from A's bytes as its own store…
  const boot = exportDb(A);
  capi.sqlite3_js_vfs_create_file('unix', '/lb3-c-boot.db', boot, boot.byteLength);
  const C = new sqlite3.oo1.DB('/lb3-c-boot.db');
  C.exec(`SELECT dolt_config('user.name','lb3c')`);
  C.exec(`SELECT dolt_config('user.email','lb3c@localhost')`);
  // …then A advances AFTER the bootstrap; C catches up via fetch + merge
  const tipA2 = commitEvent(A, '$lb3-a2', 'after join', 3002);
  writePeerFile('lb3a', exportDb(A));
  addRemote(C, 'peerA', 'lb3a');
  C.selectValue(`SELECT dolt_fetch('peerA')`);
  // C is strictly behind A's lineage → expect a clean fast-forward; plain
  // autocommit merge (no conflicts possible); record the returned value.
  let mergeOut = '(threw)';
  try { mergeOut = C.selectValue(`SELECT dolt_merge('peerA/main')`); }
  catch (e) { mergeOut = `(threw: ${e.message.slice(0, 80)})`; }
  line(`INFO lb3: C merge('peerA/main') → ${mergeOut}`);
  const caught = Number(C.selectValue(`SELECT COUNT(*) FROM events WHERE canonical_json LIKE '%after join%'`)) === 1;
  const hC = tableHashes(C); const hA = tableHashes(A);
  const mainC = C.selectValue(`SELECT dolt_hashof('main')`);
  line(`INFO lb3: C main=${mainC} (A tip ${tipA2}); events equal=${hC.events === hA.events}`);
  A.close(); C.close();
  if (caught && hC.events === hA.events && hC.state === hA.state && mainC === tipA2) {
    line(`LB3: PASS (late-peer bootstrap from bytes + catch-up via dolt_fetch + ff merge; C main == A tip)`);
    return true;
  }
  line(`LB3: FAIL — caught=${caught} eventsEq=${hC.events === hA.events} stateEq=${hC.state === hA.state} mainEq=${mainC === tipA2}`);
  return false;
}

// ============================== LB3b =======================================
// The ENGINE's joiner case: the local store has its OWN unrelated genesis
// (joinRoom commits schema genesis) — dolt_merge may refuse unrelated
// histories, so bootstrap = fetch + dolt_reset('--hard','<remote>/<branch>')
// (fetch already copied the objects; reset just repoints). Also records how
// remote-tracking refs appear in dolt_branches.
function lb3b() {
  const A = mkReplica('/lb3b-a.db', 'lb3ba');
  commitEvent(A, '$lb3b-a1', 'boot me', 3101);
  commitEvent(A, '$lb3b-a2', 'and me', 3102);
  const tipA = A.selectValue(`SELECT dolt_hashof('main')`);

  const C = mkReplica('/lb3b-c.db', 'lb3bc'); // own UNRELATED genesis (engine joiner shape)
  writePeerFile('lb3ba', exportDb(A));
  addRemote(C, 'peerA', 'lb3ba');
  C.selectValue(`SELECT dolt_fetch('peerA')`);
  const branches = C.selectObjects(`SELECT name, remote, branch FROM dolt_branches`);
  line(`INFO lb3b: dolt_branches after fetch = ${JSON.stringify(branches)}`);
  // merge attempt on unrelated histories — record the outcome verbatim
  try {
    const m = C.selectValue(`SELECT dolt_merge('peerA/main')`);
    line(`INFO lb3b: merge of unrelated history returned ${m} (no refusal)`);
  } catch (e) {
    line(`INFO lb3b: merge of unrelated history refused: ${e.message.slice(0, 100)}`);
  }
  let resetOk = true;
  try { C.exec(`SELECT dolt_reset('--hard','peerA/main')`); }
  catch (e) { resetOk = false; line(`INFO lb3b: dolt_reset('--hard','peerA/main') threw: ${e.message.slice(0, 100)}`); }
  const mainC = C.selectValue(`SELECT dolt_hashof('main')`);
  const saw = Number(C.selectValue(`SELECT COUNT(*) FROM events WHERE canonical_json LIKE '%boot me%'`)) === 1;
  const hC = tableHashes(C); const hA = tableHashes(A);
  line(`INFO lb3b: after reset: C main=${mainC} (A tip ${tipA}); sees events=${saw}; tables equal=${hC.events === hA.events && hC.state === hA.state}`);
  // and C can commit on top (next-ingest shape)
  let commitOk = true;
  try { commitEvent(C, '$lb3b-c1', 'c on adopted store', 3103); }
  catch (e) { commitOk = false; line(`INFO lb3b: commit after reset threw: ${e.message.slice(0, 100)}`); }
  A.close(); C.close();
  if (resetOk && mainC === tipA && saw && hC.events === hA.events && commitOk) {
    line(`LB3b: PASS (unrelated-genesis joiner bootstraps via fetch + dolt_reset --hard; tables equal; commits on top work)`);
    return true;
  }
  line(`LB3b: FAIL — resetOk=${resetOk} mainEq=${mainC === tipA} saw=${saw} eventsEq=${hC.events === hA.events} commitOk=${commitOk}`);
  return false;
}

// ============================== LB4 ========================================
// 10-generation longevity on the REMOTE path (the #2568 regression watch):
// C and D share genesis via bootstrap; each generation: from-side commits,
// ships bytes (IN-PLACE peer-file update), to-side dolt_fetch + ff merge,
// assert events/state table-hash equality. Per-generation lines mark the
// last clean step (watchdog mapping per LP2C: a wasm hang never yields, so
// check-lb's overall timeout is the bound).
async function lb4() {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const C = mkReplica('/lb4-c.db', 'lb4c');
  commitEvent(C, '$lb4-g0', 'genesis event', 4000);
  const boot = exportDb(C);
  capi.sqlite3_js_vfs_create_file('unix', '/lb4-d-boot.db', boot, boot.byteLength);
  const D = new sqlite3.oo1.DB('/lb4-d-boot.db');
  D.exec(`SELECT dolt_config('user.name','lb4d')`);
  D.exec(`SELECT dolt_config('user.email','lb4d@localhost')`);

  writePeerFile('lb4c', exportDb(C)); addRemote(D, 'peerC', 'lb4c');
  writePeerFile('lb4d', exportDb(D)); addRemote(C, 'peerD', 'lb4d');

  const gen = (g, from, to, fromName, toName, remoteOnTo, peerFileName) => {
    const t0 = performance.now();
    commitEvent(from, `$lb4-g${g}-${fromName}`, `gen ${g} from ${fromName}`, 4000 + g);
    writePeerFile(peerFileName, exportDb(from)); // IN-PLACE update (LB1-proven form)
    to.selectValue(`SELECT dolt_fetch('${remoteOnTo}')`);
    to.selectValue(`SELECT dolt_merge('${remoteOnTo}/main')`);
    const hF = tableHashes(from); const hT = tableHashes(to);
    if (hF.events !== hT.events || hF.state !== hT.state) {
      throw new Error(`gen ${g}: table hash mismatch after fetch+merge (events ${hF.events}/${hT.events} state ${hF.state}/${hT.state})`);
    }
    line(`LB4-GEN ${g}: ok (${Math.round(performance.now() - t0)} ms; ${fromName}→${toName} fetch+merge; events ${hF.events.slice(0, 8)})`);
  };

  for (let g = 1; g <= 10; g++) {
    if (g % 2 === 1) gen(g, C, D, 'c', 'd', 'peerC', 'lb4c');
    else gen(g, D, C, 'd', 'c', 'peerD', 'lb4d');
    await tick();
  }
  C.close(); D.close();
  line('LB4: 10/10 GENERATIONS CLEAN');
  return true;
}

// ============================== driver =====================================
let pass = 0;
try { if (lb1()) pass++; } catch (e) { line(`LB1: FAIL — ${e.message}`); }
try { if (lb2()) pass++; } catch (e) { line(`LB2: FAIL — ${e.message}`); }
try { if (lb3()) pass++; } catch (e) { line(`LB3: FAIL — ${e.message}`); }
try { if (lb3b()) pass++; } catch (e) { line(`LB3b: FAIL — ${e.message}`); }
try { if (await lb4()) pass++; } catch (e) { line(`LB4: FAIL — ${e.message}`); }
line(`LB SPIKES: ${pass}/5 PASS`);
