// engine-lite.js — communico room engine on DoltLite-WASM (browser POC).
// The server engine's invariants in miniature, per lite/RESULTS.md:
//   commit-per-event; branch-per-extremity (D8 branch-first); ≤2 prev_events
//   (D1); wire event id = '$'+commit hash (Mode-B spirit); 2-prev merges via
//   the LS3-recorded explicit-transaction driver sequence (latest-wins, D4).
// WASM-specific rules (L1): ONE long-lived connection per db (no '@' reopens,
// no second handles); branch switching via dolt_checkout on that connection;
// dolt_config is per-connection — set once here.
import sqlite3InitModule from './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs';

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

export async function createRoom(displayName) {
  const sqlite3 = await sqlite3Ready();
  // L1 found no persistent VFS in the tested browser (opfs = worker-only,
  // opfs-sahpool needs createSyncAccessHandle). Detect once anyway; a host
  // that has it gets persistence for free.
  let db; let persistent = false;
  if (globalThis.crossOriginIsolated === true && sqlite3.installOpfsSAHPoolVfs) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs();
      db = new sqlite3.oo1.DB('/communico-room.db', 'c', pool.vfsName ?? 'opfs-sahpool');
      persistent = true;
    } catch { /* fall through to memory */ }
  }
  db ??= new sqlite3.oo1.DB('/communico-room.db'); // in-memory (MEMFS)

  const self = `@${displayName}:browser`;
  db.exec(`SELECT dolt_config('user.name','${self.replaceAll("'", "''")}')`);
  db.exec(`SELECT dolt_config('user.email','${self.replaceAll("'", "''")}')`);
  db.exec(SCHEMA);
  db.exec(`SELECT dolt_commit('-Am','schema: events+state')`);

  const room = {
    db, self, persistent,
    branch: 'main',          // current tip branch (engine stays on it)
    seq: 0,                  // extremity branch counter
    extremities: [],         // [{branch, hash, wireId}]
    eventIndex: new Map(),   // wireId → {hash, branch}
    byProvisional: new Map(),// provisionalId → wireId
  };
  const createEvt = await ingestEvent(room, {
    type: 'm.room.create', state_key: '', sender: self,
    content: { creator: self, room_version: 'lite.communico.dolt.v1' },
    prev_events: [], origin_ts: Date.now(),
  });
  await ingestEvent(room, {
    type: 'm.room.member', state_key: self, sender: self,
    content: { membership: 'join', displayname: displayName },
    prev_events: [createEvt.event_id], origin_ts: Date.now(),
  });
  return room;
}

export async function ingestEvent(room, evt) {
  const { db } = room;
  const prevs = evt.prev_events ?? [];
  if (prevs.length > 2) throw new Error('M_TOO_MANY_PREV_EVENTS: >2 prev_events rejected (D1)');
  const provisional = '$' + crypto.randomUUID();
  const branch = 'x' + (++room.seq);

  // D8 branch-first: land on the FIRST prev's branch tip, then create+switch
  // to the new extremity branch BEFORE any merge or write.
  const base = prevs.length ? room.eventIndex.get(prevs[0])?.branch : 'main';
  if (!base) throw new Error(`unknown prev_event ${prevs[0]}`);
  db.exec(`SELECT dolt_checkout('${base}')`);
  db.exec(`SELECT dolt_checkout('-b','${branch}')`);

  const inTxn = prevs.length === 2;
  if (inTxn) db.exec('BEGIN');
  try {
    if (inTxn) {
      const other = room.eventIndex.get(prevs[1])?.branch;
      if (!other) throw new Error(`unknown prev_event ${prevs[1]}`);
      mergeDriver(room, other);
    }
    const canon = JSON.stringify(evt.content ? { ...evt, content: evt.content } : evt);
    db.exec({
      sql: `INSERT INTO events VALUES (?,?,?,?,?,?)`,
      bind: [provisional, evt.type, evt.state_key ?? null, evt.sender, evt.origin_ts, canon],
    });
    if (evt.state_key != null) {
      db.exec({
        sql: `INSERT OR REPLACE INTO state VALUES (?,?,?,?)`,
        bind: [evt.type, evt.state_key, provisional, canon],
      });
    }
    const hash = db.selectValue(
      `SELECT dolt_commit('-Am','event ${provisional} type ${evt.type}')`);
    if (inTxn) { try { db.exec('COMMIT'); } catch { /* dolt_commit finalized the txn (L0/WS3-recorded) */ } }
    const wireId = '$' + hash;
    room.eventIndex.set(wireId, { hash, branch });
    room.byProvisional.set(provisional, wireId);
    // consume prev extremities (-D: LS2 recorded it works, merged or not)
    for (const p of prevs) {
      const pb = room.eventIndex.get(p).branch;
      db.exec(`SELECT dolt_branch('-D','${pb}')`);
      room.extremities = room.extremities.filter((e) => e.branch !== pb);
    }
    room.extremities.push({ branch, hash, wireId });
    room.branch = branch;
    return { event_id: wireId, hash, branch };
  } catch (e) {
    if (inTxn) { try { db.exec('ROLLBACK'); } catch { /* already finalized */ } }
    throw e;
  }
}

// LS3-recorded sequence: merge inside BEGIN (conflict error-line tolerated,
// state held) → inspect conflicts → resolve --ours → driver UPDATE
// (latest-wins by (origin_ts, event_id), D4) → GUARD empty. Caller commits.
function mergeDriver(room, otherBranch) {
  const { db } = room;
  try { db.exec(`SELECT dolt_merge('${otherBranch}')`); }
  catch (e) { if (!/conflict/i.test(e.message)) throw e; }
  const conflicts = db.selectObjects(`SELECT * FROM dolt_conflicts`);
  for (const c of conflicts) {
    if (c.table === 'events') throw new Error('E_EVENTS_CONFLICT: events must never conflict');
    if (c.table !== 'state') throw new Error(`unexpected conflict table: ${c.table}`);
  }
  if (!conflicts.length) return; // clean merge, nothing to resolve
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

export function timeline(room) {
  return room.db.selectObjects(
    `SELECT event_id AS provisional, type, sender, origin_ts, canonical_json
     FROM events ORDER BY origin_ts DESC, event_id DESC`)
    .map((r) => ({
      event_id: room.byProvisional.get(r.provisional) ?? r.provisional,
      type: r.type, sender: r.sender, origin_ts: r.origin_ts,
      content: JSON.parse(r.canonical_json).content,
    }));
}

export function doltLog(room, limit = 10) {
  return room.db.selectObjects(
    `SELECT commit_hash AS hash, message FROM dolt_log LIMIT ${Number(limit) | 0}`)
    .map((r) => ({ ...r, hash8: r.hash.slice(0, 8) }));
}

export function rawQuery(room, sql) {
  if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
    throw new Error('read-only: only SELECT/PRAGMA allowed in this console');
  }
  const columns = [];
  const rows = room.db.exec({ sql, returnValue: 'resultRows', columnNames: columns });
  return { columns, rows };
}
