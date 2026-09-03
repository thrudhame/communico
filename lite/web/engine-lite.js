// engine-lite.js — communico room engine on DoltLite-WASM (browser POC).
// MS1 rework (matrix-sync plan): event identity is the CONTENT HASH
// (Matrix reference-hash style; sync/eventid.js — ported from the server
// engine) — deterministic across replicas; the Dolt commit hash is a
// per-replica receipt (visible in doltLog only). Convergence is proven at
// TABLE level via dolt_hashof_table (history-independent — MS0 S-det).
// Invariants (per lite/RESULTS.md records): commit-per-event;
// branch-per-extremity (D8 branch-first); ≤2 prev_events (D1); interior
// prevs re-materialized via the MS0-recorded route
// (dolt_branch('<holder>','<commit>')); 2-prev merges via the LS3/WS3
// explicit-transaction driver (latest-wins, D4); lazy heal (never auto —
// the next user message takes the two oldest extremities as prevs).
// WASM rules (L1): ONE long-lived connection per db; no '<file>@<branch>'
// opens; dolt_checkout on the connection; per-connection dolt_config. This
// plan ships NO store images and calls NO remotes.
import sqlite3InitModule from './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs';
import { canonicalJson } from './sync/canonical.js';
import { eventIdFor } from './sync/eventid.js';

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

let sqlite3P = null;
const sqlite3Ready = () => (sqlite3P ??= sqlite3InitModule());

async function openStore(name) {
  const sqlite3 = await sqlite3Ready();
  // L1 found no persistent VFS in the tested browser; detect anyway — but
  // MS4: the probe is an unbounded await in some environments, so race it
  // against a 3 s timeout. Timeout OR rejection → memory, exactly as before.
  let db; let persistent = false;
  if (globalThis.crossOriginIsolated === true && sqlite3.installOpfsSAHPoolVfs) {
    try {
      const pool = await Promise.race([
        sqlite3.installOpfsSAHPoolVfs(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('opfs probe timeout (3s)')), 3000)),
      ]);
      db = new sqlite3.oo1.DB(`/communico-${name}-${crypto.randomUUID()}.db`, 'c', pool.vfsName ?? 'opfs-sahpool');
      persistent = true;
    } catch { /* fall through to memory */ }
  }
  db ??= new sqlite3.oo1.DB(`/communico-${name}-${crypto.randomUUID()}.db`); // in-memory (MEMFS)
  return { db, persistent };
}

function newRoom(db, self, persistent) {
  return {
    db, self, persistent,
    seq: 0,
    eventIndex: new Map(),   // eventId → {hash, branch, alive, origin_ts}
    extremityList: [],       // [{eventId, branch}] — alive extremity branches
    badEvents: 0,            // hash-mismatch remote rejections (in __syncStats)
    merges: 0,               // 2-prev (heal) ingests performed
  };
}

// Create a room (genesis: m.room.create + creator's member join).
export async function createRoom(displayName, roomName = 'room') {
  const { db, persistent } = await openStore(roomName);
  const self = `@${displayName}:browser`;
  db.exec(`SELECT dolt_config('user.name','${self.replaceAll("'", "''")}')`);
  db.exec(`SELECT dolt_config('user.email','${self.replaceAll("'", "''")}')`);
  db.exec(SCHEMA);
  db.selectValue(`SELECT dolt_commit('-Am','schema: events+state')`);
  const room = newRoom(db, self, persistent);
  const createEvt = await ingestEvent(room, {
    type: 'm.room.create', state_key: '',
    content: { creator: self, room_version: 'lite.communico.dolt.v1' },
  });
  await ingestEvent(room, {
    type: 'm.room.member', state_key: self,
    content: { membership: 'join', displayname: displayName },
  }, [createEvt.event_id]);
  return room;
}

// Join: a joiner builds its OWN store from events — schema only, NO genesis
// (the full history arrives via the sync protocol's delta).
export async function joinRoom(displayName, roomName = 'room') {
  const { db, persistent } = await openStore(roomName);
  const self = `@${displayName}:browser`;
  db.exec(`SELECT dolt_config('user.name','${self.replaceAll("'", "''")}')`);
  db.exec(`SELECT dolt_config('user.email','${self.replaceAll("'", "''")}')`);
  db.exec(SCHEMA);
  db.selectValue(`SELECT dolt_commit('-Am','schema: events+state')`);
  return newRoom(db, self, persistent);
}

async function makePdu(room, evt, prevs) {
  const pdu = {
    type: evt.type, room_id: '!lite:browser', sender: evt.sender ?? room.self,
    content: evt.content, prev_events: prevs,
    origin_server_ts: evt.origin_ts ?? Date.now(), depth: 0,
  };
  if (evt.state_key !== undefined) pdu.state_key = evt.state_key;
  pdu.event_id = await eventIdFor(pdu);
  return pdu;
}

// Lazy heal (normative): with >1 extremity, prevs = the two OLDEST by
// (origin_ts of tip event, event_id). >2 extremities chain-heal two at a
// time on successive messages.
function lazyPrevs(room) {
  const sorted = [...room.extremityList].sort((a, b) => {
    const ea = room.eventIndex.get(a.eventId); const eb = room.eventIndex.get(b.eventId);
    return ea.origin_ts - eb.origin_ts || (a.eventId < b.eventId ? -1 : 1);
  });
  return sorted.slice(0, 2).map((e) => e.eventId);
}

// Local send. `prevsOverride` only for tests/genesis chaining.
export async function ingestEvent(room, evt, prevsOverride) {
  const prevs = prevsOverride ?? evt.prev_events ?? lazyPrevs(room);
  const pdu = await makePdu(room, evt, prevs);
  ingestCore(room, pdu);
  return { event_id: pdu.event_id, hash: room.eventIndex.get(pdu.event_id).hash };
}

// Remote ingest (Protocol v1 apply rule): verify content hash; known →
// no-op; unresolvable prev → held (caller re-requests); else ingest.
export async function ingestRemote(room, pdu) {
  if (!pdu || typeof pdu.event_id !== 'string') {
    room.badEvents++; return { applied: false, bad: true };
  }
  const expect = await eventIdFor(pdu);
  if (expect !== pdu.event_id) {
    room.badEvents++;
    return { applied: false, bad: true };
  }
  if (room.eventIndex.has(pdu.event_id)) return { applied: false, known: true };
  const prevs = pdu.prev_events ?? [];
  if (prevs.some((p) => !room.eventIndex.has(p))) return { applied: false, held: true };
  ingestCore(room, pdu);
  return { applied: true };
}

// MS0-recorded route: re-materialize a branch AT an interior commit.
function branchAtCommit(db, name, commitHash) {
  db.exec(`SELECT dolt_branch('${name}','${commitHash}')`);
}

function ingestCore(room, pdu) {
  const { db } = room;
  const prevs = pdu.prev_events ?? [];
  if (prevs.length > 2) throw new Error('M_TOO_MANY_PREV_EVENTS: >2 prev_events rejected (D1)');
  const branch = 'x' + (++room.seq);
  const holders = []; // re-materialized interior-prev branches (deleted post-commit)

  let baseBranch = 'main';
  if (prevs.length > 0) {
    const p0 = room.eventIndex.get(prevs[0]);
    if (!p0) throw new Error(`unknown prev ${prevs[0]}`);
    if (p0.alive) {
      baseBranch = p0.branch;
    } else {
      baseBranch = `h${room.seq}`;
      branchAtCommit(db, baseBranch, p0.hash);
      holders.push(baseBranch);
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
    const p1 = room.eventIndex.get(prevs[1]);
    if (!p1) throw new Error(`unknown prev ${prevs[1]}`);
    let other = p1.branch;
    if (!p1.alive) {
      other = `h${room.seq}m`;
      branchAtCommit(db, other, p1.hash);
      holders.push(other);
    }
    room.merges++;
    db.exec('BEGIN');
    try {
      mergeDriver(db, other);
      doInsert();
      db.selectValue(`SELECT dolt_commit('-Am','event ${pdu.event_id} type ${pdu.type} (merge)')`);
      try { db.exec('COMMIT'); } catch { /* dolt_commit finalized the txn (recorded) */ }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already finalized */ }
      throw e;
    }
  } else {
    doInsert();
    db.selectValue(`SELECT dolt_commit('-Am','event ${pdu.event_id} type ${pdu.type}')`);
  }

  const hash = db.selectValue(`SELECT dolt_hashof('${branch}')`);
  for (const p of prevs) {
    const pe = room.eventIndex.get(p);
    if (pe?.alive) {
      db.exec(`SELECT dolt_branch('-D','${pe.branch}')`);
      pe.alive = false;
      room.extremityList = room.extremityList.filter((e) => e.branch !== pe.branch);
    }
  }
  for (const h of holders) {
    try { db.exec(`SELECT dolt_branch('-D','${h}')`); } catch { /* best effort */ }
  }
  room.eventIndex.set(pdu.event_id, { hash, branch, alive: true, origin_ts: pdu.origin_server_ts });
  room.extremityList.push({ eventId: pdu.event_id, branch });
}

// LS3/WS3-recorded driver sequence (in-BEGIN; caller commits inside txn):
// merge (conflict error-line tolerated, state held) → inspect → resolve
// --ours → latest-wins UPDATE (origin_ts, event_id) → GUARD empty.
function mergeDriver(db, otherBranch) {
  try { db.exec(`SELECT dolt_merge('${otherBranch}')`); }
  catch (e) { if (!/conflict/i.test(e.message)) throw e; }
  const conflicts = db.selectObjects(`SELECT * FROM dolt_conflicts`);
  for (const c of conflicts) {
    if (c.table === 'events') throw new Error('E_EVENTS_CONFLICT: events must never conflict');
    if (c.table !== 'state') throw new Error(`unexpected conflict table: ${c.table}`);
  }
  if (!conflicts.length) return;
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
}

// Union timeline across ALL alive extremity tips (dolt_at_events per tip),
// dedup by event_id, ordered (origin_ts, event_id) — newest first, with the
// deterministic tiebreak so two converged replicas render identically.
export function timeline(room) {
  const seen = new Map();
  for (const ext of room.extremityList) {
    const h = room.eventIndex.get(ext.eventId).hash;
    for (const r of room.db.selectObjects(
      `SELECT event_id, type, sender, origin_ts, canonical_json FROM dolt_at_events('${h}')`)) {
      if (!seen.has(r.event_id)) seen.set(r.event_id, r);
    }
  }
  return [...seen.values()]
    .map((r) => ({
      event_id: r.event_id, type: r.type, sender: r.sender,
      origin_ts: r.origin_ts, content: JSON.parse(r.canonical_json).content,
      prev_events: JSON.parse(r.canonical_json).prev_events ?? [],
    }))
    .sort((a, b) => b.origin_ts - a.origin_ts || (b.event_id < a.event_id ? -1 : 1));
}

export function doltLog(room, limit = 10) {
  return room.db.selectObjects(
    `SELECT commit_hash AS hash, message FROM dolt_log LIMIT ${Number(limit) | 0}`)
    .map((r) => ({ ...r, hash8: r.hash.slice(0, 8) }));
}

// Merkle convergence badge pair (history-independent, DoltLite-documented).
export function tableHashes(room) {
  return {
    events: room.db.selectValue(`SELECT dolt_hashof_table('events')`),
    state: room.db.selectValue(`SELECT dolt_hashof_table('state')`),
  };
}

// Alive extremities, sorted deterministically by (origin_ts, eventId).
export function extremities(room) {
  return [...room.extremityList].sort((a, b) => {
    const ea = room.eventIndex.get(a.eventId); const eb = room.eventIndex.get(b.eventId);
    return ea.origin_ts - eb.origin_ts || (a.eventId < b.eventId ? -1 : 1);
  });
}

// ---- dolt-native sync support (v1b; forms proven by the LB spikes) ----

// Full store image for shipping to a peer (LP1-winning form).
export async function exportStoreImage(room) {
  const sqlite3 = await sqlite3Ready();
  return sqlite3.capi.sqlite3_js_db_export(room.db.pointer);
}

// Branch names the peer must merge after fetching our image: our alive
// extremity branches (their histories include everything main carries).
export function aliveBranches(room) {
  return [...new Set(room.extremityList.map((e) => e.branch))].sort();
}

function ensurePeerRemote(room, rname, path) {
  const seen = room.db.selectValue(
    `SELECT COUNT(*) FROM dolt_remotes WHERE name = '${rname}'`);
  if (Number(seen) === 0) {
    room.db.exec(`SELECT dolt_remote('add','${rname}','file://${path}')`);
  }
}

// Heal one remote ref into the active branch via the LS3 driver; commits a
// merge only when the working set actually changed (up-to-date refs are a
// no-op). Content-change detection reuses the table-hash pair.
// Fast-forward case (recorded verbatim): an ff-able dolt_merge inside the
// txn moves the ref immediately and leaves a clean tree, so dolt_commit
// errors "nothing to commit, working tree clean (use dolt_add to stage
// changes)" — the heal has already landed; tolerate it.
function healMerge(room, ref) {
  const { db } = room;
  const before = tableHashes(room);
  db.exec('BEGIN');
  try {
    mergeDriver(db, ref);
    const after = tableHashes(room);
    if (before.events !== after.events || before.state !== after.state) {
      try {
        db.selectValue(`SELECT dolt_commit('-Am','heal: merge ${ref}')`);
        room.merges++;
      } catch (e) {
        if (!/nothing to commit/i.test(e.message)) throw e;
      }
    }
  } finally {
    try { db.exec('COMMIT'); } catch { /* dolt_commit finalized the txn (recorded) */ }
  }
}

// After any remote-adoption the in-memory bookkeeping no longer matches the
// store (events arrived as commits, not ingests): rebuild the index from the
// events table and collapse to ONE extremity (the active branch's tip). All
// events share the tip hash — post-collapse there are no interior prevs, so
// the per-event hash precision is never needed (recorded limitation).
function rebuildIndex(room) {
  const { db } = room;
  const tipBranch = db.selectValue('SELECT active_branch()');
  const tipHash = db.selectValue(`SELECT dolt_hashof('${tipBranch}')`);
  room.eventIndex.clear();
  let tipEvt = null;
  for (const r of db.selectObjects(`SELECT event_id, origin_ts FROM events`)) {
    room.eventIndex.set(r.event_id, { hash: tipHash, branch: tipBranch, alive: true, origin_ts: r.origin_ts });
    if (!tipEvt || r.origin_ts > tipEvt.origin_ts ||
        (r.origin_ts === tipEvt.origin_ts && r.event_id > tipEvt.event_id)) {
      tipEvt = r;
    }
  }
  room.extremityList = tipEvt ? [{ eventId: tipEvt.event_id, branch: tipBranch }] : [];
}

// Remote-adoption path (the dolt pull): write the peer's store image to a
// stable per-peer MEMFS file (in-place update — LB1-proven overwrite), fetch
// from it, then merge each named branch (dolt_branches does NOT enumerate
// remote refs — LB3b — so the sender names its alive branches explicitly).
// Empty local store (joiner) bootstraps via dolt_reset --hard onto the first
// named branch (LB3b), then moves to a working branch so main is never an
// extremity (main cannot be deleted — PB3).
export async function adoptStoreImage(room, bytes, peerId, branches) {
  const sqlite3 = await sqlite3Ready();
  const safe = String(peerId).replace(/[^A-Za-z0-9_-]/g, '_');
  const rname = `peer_${safe}`;
  const path = `/peer-${safe}.db`;
  sqlite3.capi.sqlite3_js_vfs_create_file('unix', path, bytes, bytes.byteLength);
  ensurePeerRemote(room, rname, path);
  room.db.selectValue(`SELECT dolt_fetch('${rname}')`);
  const list = [...new Set(branches ?? [])].sort();
  if (!list.length) throw new Error('adoptStoreImage: peer named no branches');
  if (room.eventIndex.size === 0) {
    room.db.exec(`SELECT dolt_reset('--hard','${rname}/${list[0]}')`);
    room.db.exec(`SELECT dolt_checkout('-b','xboot')`);
    for (const b of list.slice(1)) healMerge(room, `${rname}/${b}`);
  } else {
    for (const b of list) healMerge(room, `${rname}/${b}`);
    // collapse any other alive extremities into the active tip
    const active = room.db.selectValue('SELECT active_branch()');
    for (const e of [...room.extremityList]) {
      if (e.branch !== active && e.branch !== 'main') {
        healMerge(room, e.branch);
        try { room.db.exec(`SELECT dolt_branch('-D','${e.branch}')`); } catch { /* best effort */ }
      }
    }
  }
  rebuildIndex(room);
  return { applied: true };
}

export function rawQuery(room, sql) {
  if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
    throw new Error('read-only: only SELECT/PRAGMA allowed in this console');
  }
  const columns = [];
  const rows = room.db.exec({ sql, returnValue: 'resultRows', columnNames: columns });
  return { columns, rows };
}
