// engine-lite.js — communico room engine on DoltLite-WASM (browser POC).
// F0 engine contract: full v11 PDU ingest (verbatim store, real depth,
// <=20 prev_events, declared auth_events), per-room policy slot with the
// refusing v11 stub (membership only, M_UNRESOLVED_CONFLICT on forks —
// latest-wins is retired as an exploit), state as the resolver's
// materialized cache (the ONLY writer is sync/materialize.js), adoption
// that validates + re-resolves and never crashes on a fork, and the sh
// digest in the announce. Event identity is the CONTENT HASH (Matrix
// reference-hash style; sync/eventid.js) — deterministic across replicas;
// the Dolt commit hash is a per-replica receipt (visible in doltLog
// only). Branch-per-extremity; interior prevs re-materialized via the
// MS0-recorded route (dolt_branch('<holder>','<commit>')); N-prev merges
// chain 2-parent commits (the event DAG keeps all N in prev_events).
// Lazy heal (never auto — the next user message takes the two oldest
// extremities as prevs).
// WASM rules (L1): ONE long-lived connection per db; no '<file>@<branch>'
// opens; dolt_checkout on the connection; per-connection dolt_config. This
// plan ships NO store images and calls NO remotes.
import sqlite3InitModule from './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs';
import { canonicalJson } from './sync/canonical.js';
import { eventIdFor, redact } from './sync/eventid.js';
import {
  authorized,
  resolveState,
  selectAuthEvents,
  stateKeyOf,
} from './sync/rulebook/v11-stub.js';
import {
  b32decode,
  b32encode,
  contentHashOf,
  isKeyName,
  signJson,
  verifyJson,
} from './sync/signing.js';
import { isPduShape } from './sync/pdu.js';
import { materialize } from './sync/materialize.js';

export const ROOM_VERSION = '11';

const SCHEMA = `
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL, state_key TEXT, sender TEXT NOT NULL,
  origin_ts INTEGER NOT NULL, depth INTEGER NOT NULL,
  prev_events TEXT NOT NULL DEFAULT '[]',
  auth_events TEXT NOT NULL DEFAULT '[]',
  hashes TEXT NOT NULL DEFAULT '{}',
  signatures TEXT NOT NULL DEFAULT '{}',
  rejected INTEGER NOT NULL DEFAULT 0,
  canonical_json TEXT NOT NULL
);
CREATE TABLE state (
  type TEXT NOT NULL, state_key TEXT NOT NULL,
  event_id TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (type, state_key)
);`;

let sqlite3P = null;
const sqlite3Ready = () => (sqlite3P ??= sqlite3InitModule());

// Test seam (headless checks): the shared wasm singleton. Never init a
// second module instance in-process — its binary fetch breaks.
export function sqlite3Module() {
  return sqlite3Ready();
}

// ---- Browser homeserver identity (F1 step 20) ----
//
// The browser IS a homeserver (ruling R8/R10): it holds one ed25519
// keypair (minted on first run, persisted — localStorage now, OPFS
// later); the key lowercased-unpadded-base32 IS its `server_name`.
// Concurrent personas (Delta-style profiles): N localparts under the one
// key (`@alice:<lite-b32>`, `@bob:<lite-b32>`), each fixed at creation;
// `displayname` in the member event is the only renaming. Rooms belong
// to a profile; every profile's PDUs are signed by the one browser key;
// portability = the browser key (export/import moves every profile).

const IDENTITY_KEY = 'communico.identity.v1';

// Spec localpart grammar (appendices § User Identifiers), shared with the
// server's checkLocalpart (api/engine/tenant.ts).
const LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;

let identityCache = null; // {privateKey, publicKey, serverName, profiles, active}

function persistIdentity(blob) {
  try {
    globalThis.localStorage?.setItem(IDENTITY_KEY, JSON.stringify(blob));
  } catch { /* private mode etc: identity lives for the session only */ }
}

function loadIdentityBlob() {
  try {
    const raw = globalThis.localStorage?.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw);
    if (!blob?.jwk || !Array.isArray(blob.profiles)) return null;
    return blob;
  } catch {
    return null;
  }
}

function keyNameFor(rawPub32) {
  return b32encode(rawPub32).replace(/=+$/, '').toLowerCase();
}

// Ensure (load or mint) the browser homeserver identity.
export async function ensureIdentity() {
  if (identityCache) return identityCache;
  const blob = loadIdentityBlob();
  if (blob) {
    const privateKey = await crypto.subtle.importKey(
      'jwk', blob.jwk, { name: 'Ed25519' }, true, ['sign']);
    const pubRaw = b32decode(blob.serverName);
    const publicKey = await crypto.subtle.importKey(
      'raw', pubRaw, { name: 'Ed25519' }, true, ['verify']);
    identityCache = {
      privateKey, publicKey,
      serverName: blob.serverName,
      profiles: blob.profiles,
      active: blob.active ?? blob.profiles[0]?.localpart ?? null,
    };
    return identityCache;
  }
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign', 'verify',
  ]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const serverName = keyNameFor(pubRaw);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const fresh = { jwk, serverName, profiles: [], active: null };
  persistIdentity(fresh);
  identityCache = {
    privateKey: kp.privateKey, publicKey: kp.publicKey,
    serverName, profiles: [], active: null,
  };
  return identityCache;
}

export function identityInfo() {
  if (!identityCache) return null;
  return {
    serverName: identityCache.serverName,
    profiles: identityCache.profiles.map((p) => ({ ...p })),
    active: identityCache.active,
  };
}

// Create a persona (localpart fixed at creation) or return the existing
// one; makes it active. Displayname renames freely (member-event scope).
// Multi-tab safe: profiles reload-merge from storage on every write, so
// two tabs creating different personas union instead of clobbering.
export async function createProfile(localpart, displayname) {
  const id = await ensureIdentity();
  const lp = String(localpart).toLowerCase();
  if (!LOCALPART_RE.test(lp) || lp.length === 0 || lp.length > 255) {
    throw new Error('M_INVALID_USERNAME: ' + String(localpart));
  }
  const fresh = loadIdentityBlob();
  const merged = new Map((fresh?.profiles ?? []).map((p) => [p.localpart, { ...p }]));
  for (const p of id.profiles) {
    if (!merged.has(p.localpart)) merged.set(p.localpart, { ...p });
  }
  let p = merged.get(lp);
  if (!p) {
    p = { localpart: lp, displayname: displayname ?? lp };
    merged.set(lp, p);
  } else if (displayname) {
    p.displayname = displayname;
  }
  id.profiles = [...merged.values()];
  id.active = lp;
  persistIdentity({
    jwk: await crypto.subtle.exportKey('jwk', id.privateKey),
    serverName: id.serverName,
    profiles: id.profiles,
    active: id.active,
  });
  return { ...p };
}

export async function switchProfile(localpart) {
  const id = await ensureIdentity();
  const lp = String(localpart).toLowerCase();
  const fresh = loadIdentityBlob();
  if (fresh) {
    const seen = new Set(id.profiles.map((p) => p.localpart));
    for (const p of fresh.profiles) {
      if (!seen.has(p.localpart)) id.profiles.push({ ...p });
    }
  }
  const p = id.profiles.find((x) => x.localpart === lp);
  if (!p) throw new Error('M_NOT_FOUND: unknown profile');
  id.active = p.localpart;
  persistIdentity({
    jwk: await crypto.subtle.exportKey('jwk', id.privateKey),
    serverName: id.serverName,
    profiles: id.profiles,
    active: id.active,
  });
  return { ...p };
}

export function activeMxid() {
  if (!identityCache?.active) return null;
  return `@${identityCache.active}:${identityCache.serverName}`;
}

function serverNameOf(mxid) {
  const i = String(mxid).indexOf(':');
  return i < 0 ? '' : String(mxid).slice(i + 1);
}

// Verify a PDU against the sender's key-is-name key. Returns true when
// verified; DNS/legacy-named senders have no fetchable key in F1 (no
// /keys endpoint — M5) and are accepted unverified (the lite hat is the
// trust channel; recorded). Key-named senders MUST verify or carry no
// trust at all: unsigned-or-bad from a key name is rejected.
const peerKeyCache = new Map();
async function verifyPeerSignature(pdu) {
  const sender = String(pdu.sender ?? '');
  const origin = serverNameOf(sender);
  if (!isKeyName(origin)) return 'unverifiable-origin';
  const sigs = pdu.signatures?.[origin] ?? {};
  const kids = Object.keys(sigs);
  if (kids.length === 0) return 'unsigned';
  let pub = peerKeyCache.get(origin);
  if (!pub) {
    pub = await crypto.subtle.importKey(
      'raw', b32decode(origin), { name: 'Ed25519' }, true, ['verify']);
    peerKeyCache.set(origin, pub);
  }
  const redacted = redact(pdu, ROOM_VERSION);
  redacted.signatures = pdu.signatures;
  for (const kid of kids) {
    const ok = await verifyJson(redacted, origin, kid, pub);
    if (ok) return 'ok';
  }
  return 'bad-signature';
}

// Portability: the whole identity (key + profiles) as a portable blob.
export async function exportIdentity() {
  const id = await ensureIdentity();
  return {
    jwk: await crypto.subtle.exportKey('jwk', id.privateKey),
    serverName: id.serverName,
    profiles: id.profiles.map((p) => ({ ...p })),
  };
}

export async function importIdentity(blob) {
  if (!blob?.jwk || typeof blob.serverName !== 'string') {
    throw new Error('M_BAD_REQUEST: not an identity blob');
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk', blob.jwk, { name: 'Ed25519' }, true, ['sign']);
  const pubRaw = b32decode(blob.serverName);
  if (!pubRaw || pubRaw.length !== 32) throw new Error('M_BAD_REQUEST: bad server name');
  const publicKey = await crypto.subtle.importKey(
    'raw', pubRaw, { name: 'Ed25519' }, true, ['verify']);
  const profiles = Array.isArray(blob.profiles) ? blob.profiles : [];
  identityCache = {
    privateKey, publicKey,
    serverName: blob.serverName,
    profiles,
    active: profiles[0]?.localpart ?? null,
  };
  persistIdentity({
    jwk: blob.jwk,
    serverName: blob.serverName,
    profiles,
    active: identityCache.active,
  });
  return identityInfo();
}

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

function newRoom(db, self, persistent, roomId = null) {
  return {
    db, self, persistent,
    roomId,                // pdu room_id override (a server room's id when
                           // hatted; null → '!lite:browser' browser mesh)
    roomVersion: ROOM_VERSION,
    seq: 0,
    eventIndex: new Map(),   // eventId → {hash, branch, alive, origin_ts, depth}
    extremityList: [],       // [{eventId, branch}] — alive extremity branches
    badEvents: 0,            // hash-mismatch remote rejections (in __syncStats)
    merges: 0,               // multi-prev (heal) ingests performed
    refusals: 0,             // stub refusals surfaced (auth/conflict)
  };
}

// Create a room as the ACTIVE profile (v11 genesis: m.room.create +
// creator join + power_levels + join_rules, each authored + ingested
// through the normal pipeline). displayName seeds the profile's
// displayname on first use; rooms belong to the creating profile.
export async function createRoom(displayName, roomName = 'room', roomId = null) {
  const profile = await createProfile(displayName, displayName);
  const self = `@${profile.localpart}:${(await ensureIdentity()).serverName}`;
  const { db, persistent } = await openStore(roomName);
  db.exec(`SELECT dolt_config('user.name','${self.replaceAll("'", "''")}')`);
  db.exec(`SELECT dolt_config('user.email','${self.replaceAll("'", "''")}')`);
  db.exec(SCHEMA);
  db.selectValue(`SELECT dolt_commit('-Am','schema: events+state')`);
  const room = newRoom(db, self, persistent, roomId);
  room.profile = profile.localpart;
  await ingestEvent(room, {
    type: 'm.room.create', state_key: '',
    content: { room_version: ROOM_VERSION },
  });
  await ingestEvent(room, {
    type: 'm.room.member', state_key: self,
    content: { membership: 'join', displayname: profile.displayname },
  });
  await ingestEvent(room, {
    type: 'm.room.power_levels', state_key: '',
    content: {
      users: { [self]: 100 }, users_default: 0, events_default: 0,
      state_default: 50, invite: 100, kick: 100, ban: 100, redact: 100,
    },
  });
  await ingestEvent(room, {
    type: 'm.room.join_rules', state_key: '',
    content: { join_rule: 'invite' },
  });
  return room;
}

// Join as the ACTIVE profile: a joiner builds its OWN store from events —
// schema only, NO genesis (the full history arrives via the sync
// protocol's delta). roomId: the remote room's id when hatted (ws
// transport) — the content-hash id of a room event covers room_id, so a
// server room's events MUST carry the server's room id or the two engines
// mint different ids for one event.
export async function joinRoom(displayName, roomName = 'room', roomId = null) {
  const profile = await createProfile(displayName, displayName);
  const self = `@${profile.localpart}:${(await ensureIdentity()).serverName}`;
  const { db, persistent } = await openStore(roomName);
  db.exec(`SELECT dolt_config('user.name','${self.replaceAll("'", "''")}')`);
  db.exec(`SELECT dolt_config('user.email','${self.replaceAll("'", "''")}')`);
  db.exec(SCHEMA);
  db.selectValue(`SELECT dolt_commit('-Am','schema: events+state')`);
  const room = newRoom(db, self, persistent, roomId);
  room.profile = profile.localpart;
  return room;
}

// Read the working state table into a StateMap (key -> event_id).
function readStateMap(db) {
  const m = new Map();
  for (const r of db.selectObjects(`SELECT type, state_key, event_id FROM state`)) {
    m.set(stateKeyOf(r.type, r.state_key ?? ''), r.event_id);
  }
  return m;
}

function readStateRows(db) {
  return db.selectObjects(`SELECT type, state_key, event_id, content FROM state`)
    .map((r) => ({
      type: r.type, stateKey: r.state_key ?? '', eventId: r.event_id,
      content: JSON.parse(r.content),
    }));
}

// Validated-PDU lookup over the events table (immutable rows — any
// checkout that contains the event will serve).
function makeGetEvent(db, extra) {
  const cache = new Map(extra);
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const r = db.selectObject(
      `SELECT canonical_json FROM events WHERE event_id = ?`, [id]);
    if (!r) return undefined;
    const pdu = JSON.parse(r.canonical_json);
    cache.set(id, pdu);
    return pdu;
  };
}

// Local authoring: full v11 PDU (depth, selected auth_events,
// content-hash, reference-hash id), then redact-and-sign with the
// browser homeserver key (spec order — F1 step 21, same as the server).
async function authorPdu(room, evt, prevs) {
  const prevRows = prevs.map((id) => {
    const e = room.eventIndex.get(id);
    if (!e) throw new Error(`unknown prev ${id}`);
    return e;
  });
  const depth = prevRows.length === 0
    ? 1
    : Math.max(...prevRows.map((e) => e.depth)) + 1;
  const isCreate = evt.type === 'm.room.create' && prevs.length === 0;
  // Parent states: single-prev reads the working set (the tip); forks
  // resolve across the parents' own checkouts (see ingestCore).
  const pdu = {
    type: evt.type, room_id: room.roomId ?? '!lite:browser',
    sender: evt.sender ?? room.self,
    content: evt.content ?? {}, prev_events: [...prevs],
    auth_events: [],
    origin_server_ts: evt.origin_ts ?? Date.now(), depth,
    hashes: { sha256: '' }, signatures: {},
  };
  if (evt.state_key !== undefined) pdu.state_key = evt.state_key;
  if (!isCreate) {
    const stateAtPrevs = readStateMap(room.db);
    const createId = stateAtPrevs.get(stateKeyOf('m.room.create', ''));
    if (!createId) throw new Error('M_NO_CREATE: parent state has no create');
    pdu.auth_events = selectAuthEvents(pdu, {
      stateAtPrevs,
      getEvent: makeGetEvent(room.db, new Map()),
      createEventId: createId,
    });
  }
  pdu.hashes = { sha256: await contentHashOf(pdu) };
  pdu.event_id = await eventIdFor(pdu, ROOM_VERSION);
  // Sign the redacted form with the browser key; attach under our name.
  const id = await ensureIdentity();
  const redacted = redact(pdu, ROOM_VERSION);
  await signJson(redacted, id.serverName, 'ed25519:1', id.privateKey);
  pdu.signatures = redacted.signatures ?? {};
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
  if (prevs.length > 20) throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  const pdu = evt.event_id && evt.hashes && evt.auth_events
    ? evt // already a full PDU (tests driving the wire shape)
    : await authorPdu(room, evt, prevs);
  await ingestCore(room, pdu);
  return { event_id: pdu.event_id, hash: room.eventIndex.get(pdu.event_id).hash };
}

// Remote ingest: verify content hash AND origin signature; known →
// no-op; unresolvable prev → held (caller re-requests); refusals
// (auth/conflict) surface as {refused} — never swallowed, never guessed
// past. Else ingest. Key-named senders must verify (unsigned-or-bad from
// a key name is rejected — the tampered-signature vector); DNS/legacy
// names have no fetchable key in F1 (no /keys — M5) and ride the channel.
export async function ingestRemote(room, pdu) {
  if (!pdu || typeof pdu.event_id !== 'string' || !isPduShape(pdu)) {
    room.badEvents++; return { applied: false, bad: true };
  }
  let expect;
  try {
    expect = await eventIdFor(pdu, ROOM_VERSION);
  } catch {
    room.badEvents++; return { applied: false, bad: true };
  }
  if (expect !== pdu.event_id) {
    room.badEvents++;
    return { applied: false, bad: true };
  }
  // Declared content hash must match the wire form (event_id stripped —
  // the v11 wire form has no such field; it is derived).
  const { event_id: _drop, ...noId } = pdu;
  if (await contentHashOf(noId) !== pdu.hashes?.sha256) {
    room.badEvents++;
    return { applied: false, bad: true };
  }
  // Origin signature (F1 step 20: key-is-name, nothing to fetch).
  const verdict = await verifyPeerSignature(pdu);
  if (verdict === 'bad-signature' || verdict === 'unsigned') {
    room.badEvents++;
    return { applied: false, bad: true };
  }
  if (room.eventIndex.has(pdu.event_id)) return { applied: false, known: true };
  const prevs = pdu.prev_events ?? [];
  if (prevs.some((p) => !room.eventIndex.has(p))) return { applied: false, held: true };
  try {
    await ingestCore(room, pdu);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/M_UNRESOLVED_CONFLICT|M_AUTHCHAIN_REJECT|M_STATE_REJECT/.test(msg)) {
      room.refusals++;
      return { applied: false, refused: true, reason: msg };
    }
    throw e;
  }
  return { applied: true };
}

// MS0-recorded route: re-materialize a branch AT an interior commit.
function branchAtCommit(db, name, commitHash) {
  db.exec(`SELECT dolt_branch('${name}','${commitHash}')`);
}

async function ingestCore(room, pdu) {
  const { db } = room;
  const prevs = pdu.prev_events ?? [];
  if (prevs.length > 20) throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  if ((pdu.auth_events ?? []).length > 10) {
    throw new Error('M_TOO_MANY_AUTH_EVENTS: v11 allows at most 10');
  }
  const branch = 'x' + (++room.seq);
  const holders = []; // re-materialized interior-prev branches (deleted post-commit)
  const checkouts = []; // temp checkouts for reading other parents' state

  // Resolve base branch (prevs[0]) — re-materializing interior prevs.
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

  // Parent state sets: parent[0] is the working set; each further parent
  // is read on its own checkout (its branch carries its state), then we
  // return. getEvent reads ride along (events rows are branch-scoped).
  const parentSets = [readStateMap(db)];
  const getEventCache = new Map();
  const getEvent = makeGetEvent(db, getEventCache);
  const otherBranches = [];
  for (const pid of prevs.slice(1)) {
    const pe = room.eventIndex.get(pid);
    if (!pe) throw new Error(`unknown prev ${pid}`);
    let other = pe.branch;
    if (!pe.alive) {
      other = `h${room.seq}m${otherBranches.length}`;
      branchAtCommit(db, other, pe.hash);
      holders.push(other);
    }
    otherBranches.push(other);
    db.exec(`SELECT dolt_checkout('${other}')`);
    parentSets.push(readStateMap(db));
    checkouts.push(other);
  }
  if (otherBranches.length) db.exec(`SELECT dolt_checkout('${branch}')`);

  // Auth context over the RESOLVED parents (throws M_UNRESOLVED_CONFLICT
  // — the room stays forked; the heal is stored below as rejected).
  const isCreate = pdu.type === 'm.room.create' && prevs.length === 0;
  const createId = isCreate
    ? pdu.event_id
    : parentSets[0].get(stateKeyOf('m.room.create', ''));
  if (!createId) throw new Error('M_NO_CREATE: no create in ancestry');
  let resolved;
  let conflicted = false;
  try {
    resolved = resolveState(parentSets);
  } catch (e) {
    if (!/M_UNRESOLVED_CONFLICT/.test(String(e?.message ?? e))) throw e;
    conflicted = true;
    resolved = new Map(parentSets[0]);
  }
  const ctx = { stateAtPrevs: resolved, getEvent, createEventId: createId };
  let verdict = 'ok';
  const selected = isCreate ? [] : selectAuthEvents(pdu, ctx);
  if (!sameIdSet(pdu.auth_events ?? [], selected)) {
    verdict = 'authchain-reject';
  } else {
    verdict = authorized(pdu, ctx);
  }
  // Depth recheck (genesis = 1).
  const wantDepth = prevs.length === 0
    ? 1
    : Math.max(...prevs.map((id) => room.eventIndex.get(id).depth)) + 1;
  if (pdu.depth !== wantDepth) verdict = 'authchain-reject';
  const rejected = conflicted || verdict !== 'ok';

  // Resolved rows (contents from validated PDUs only).
  const rows = [];
  for (const [k, eid] of resolved) {
    const ep = getEvent(eid);
    if (!ep) throw new Error('E_STATE_EVENT_MISSING: ' + eid);
    const sep = k.indexOf('\0');
    rows.push({
      type: k.slice(0, sep), stateKey: k.slice(sep + 1), eventId: eid,
      content: ep.content ?? {},
    });
  }
  if (!rejected && pdu.state_key != null) {
    const at = rows.findIndex((r) =>
      r.type === String(pdu.type) && r.stateKey === String(pdu.state_key));
    const row = {
      type: String(pdu.type), stateKey: String(pdu.state_key),
      eventId: pdu.event_id, content: pdu.content ?? {},
    };
    if (at >= 0) rows[at] = row;
    else rows.push(row);
  }

  const doInsert = () => {
    db.exec({
      sql: `INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      bind: [
        pdu.event_id, pdu.type, pdu.state_key ?? null, pdu.sender,
        pdu.origin_server_ts, pdu.depth,
        JSON.stringify(prevs), JSON.stringify(pdu.auth_events ?? []),
        JSON.stringify(pdu.hashes ?? {}), JSON.stringify(pdu.signatures ?? {}),
        rejected ? 1 : 0, canonicalJson(pdu),
      ],
    });
    // State is the resolver's materialized cache — the ONLY writer is
    // materialize() (sync/materialize.js; the gate grep proves it).
    materialize(db, rows);
  };

  if (otherBranches.length > 0) {
    // N-way fan-in chains 2-parent commits (Dolt holds one active merge
    // at a time — each merge but the last commits as bookkeeping; only
    // the final commit carries the event). The event DAG keeps all N in
    // prev_events; resolution already ran over the full parent set.
    room.merges++;
    for (let i = 0; i < otherBranches.length; i++) {
      const last = i === otherBranches.length - 1;
      db.exec('BEGIN');
      try {
        mergeDriver(db, otherBranches[i]);
        if (!last) {
          db.selectValue(`SELECT dolt_commit('-Am','fan-in ${i + 2}/${prevs.length} for ${pdu.event_id}')`);
        } else {
          doInsert();
          db.selectValue(`SELECT dolt_commit('-Am','event ${pdu.event_id} type ${pdu.type} (merge)')`);
        }
        try { db.exec('COMMIT'); } catch { /* dolt_commit finalized the txn (recorded) */ }
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already finalized */ }
        throw e;
      }
    }
  } else {
    doInsert();
    db.selectValue(`SELECT dolt_commit('-Am','event ${pdu.event_id} type ${pdu.type}')`);
  }

  const hash = db.selectValue(`SELECT dolt_hashof('${branch}')`);
  // On conflict refusal the parents stay alive (the room stays forked;
  // the refused tip joins them — nothing is dropped or guessed).
  if (!conflicted) {
    for (const p of prevs) {
      const pe = room.eventIndex.get(p);
      if (pe?.alive) {
        db.exec(`SELECT dolt_branch('-D','${pe.branch}')`);
        pe.alive = false;
        room.extremityList = room.extremityList.filter((e) => e.branch !== pe.branch);
      }
    }
  }
  for (const h of holders) {
    try { db.exec(`SELECT dolt_branch('-D','${h}')`); } catch { /* best effort */ }
  }
  room.eventIndex.set(pdu.event_id, {
    hash, branch, alive: true,
    origin_ts: pdu.origin_server_ts, depth: pdu.depth,
  });
  room.extremityList.push({ eventId: pdu.event_id, branch });

  if (conflicted) {
    throw new Error(
      'M_UNRESOLVED_CONFLICT: concurrent edits to one state key are refused (stub)',
    );
  }
  if (verdict !== 'ok') {
    throw new Error(
      (verdict === 'authchain-reject' ? 'M_AUTHCHAIN_REJECT: ' : 'M_STATE_REJECT: ') +
      pdu.event_id,
    );
  }
}

function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Mechanical merge only (F0: latest-wins retired as an exploit). Dolt's
// cell-wise merge is never trusted for state: --no-commit joins the
// working set only (a clean merge must NOT auto-commit — one event is
// one commit); conflicts clear --ours and the caller overwrites via
// materialize() with the rulebook's resolution. Dolt decides nothing.
function mergeDriver(db, otherBranch) {
  try { db.exec(`SELECT dolt_merge('--no-commit','${otherBranch}')`); }
  catch (e) { if (!/conflict/i.test(e.message)) throw e; }
  const conflicts = db.selectObjects(`SELECT * FROM dolt_conflicts`);
  for (const c of conflicts) {
    if (c.table === 'events') throw new Error('E_EVENTS_CONFLICT: events must never conflict');
    if (c.table !== 'state') throw new Error(`unexpected conflict table: ${c.table}`);
  }
  for (const c of conflicts) {
    db.exec(`SELECT dolt_conflicts_resolve('--ours','${c.table}')`);
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

// sh digest over the announced frontier's resolved state (F0-8): over
// event ids, not content. Single extremity -> digest of the working
// state; forked (contested under the stub) -> absent, not different.
export async function stateHash(room) {
  if (room.extremityList.length !== 1) return null;
  const rows = readStateRows(room.db)
    .map((r) => [r.type, r.stateKey, r.eventId])
    .sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalJson(rows)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function roomVersion(room) {
  return room.roomVersion;
}

// Alive extremities, sorted deterministically by (origin_ts, eventId).
export function extremities(room) {
  return [...room.extremityList].sort((a, b) => {
    const ea = room.eventIndex.get(a.eventId); const eb = room.eventIndex.get(b.eventId);
    return ea.origin_ts - eb.origin_ts || (a.eventId < b.eventId ? -1 : 1);
  });
}

// ---- msync facade reads (the seam: msync reaches engine state only
// through these; sync here, async SQL on the server hat) ----

// All events as parsed PDUs (delta computation).
export function allEvents(room) {
  return room.db.selectObjects(`SELECT canonical_json FROM events`)
    .map((r) => JSON.parse(r.canonical_json));
}

export function hasEvent(room, id) {
  return room.eventIndex.has(id);
}

export function eventCount(room) {
  return room.eventIndex.size;
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

// Heal one remote ref into the active branch via the mechanical driver;
// commits a merge only when the working set actually changed
// (up-to-date refs are a no-op). State after the merge is a placeholder
// (--ours); adoptStoreImage re-resolves + materializes afterwards, so
// no caller may observe state between healMerge and the replay.
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

// Rebuild bookkeeping from the store: the eventIndex from the events
// table (tip hash for all — recorded limitation) and the REAL forward
// extremities (DAG tips: events no other event references — never
// collapsed to one by origin_ts).
function rebuildIndex(room) {
  const { db } = room;
  const tipBranch = db.selectValue('SELECT active_branch()');
  const tipHash = db.selectValue(`SELECT dolt_hashof('${tipBranch}')`);
  room.eventIndex.clear();
  const children = new Map();
  const rows = db.selectObjects(`SELECT event_id, origin_ts, depth, prev_events FROM events`);
  const prevsOf = new Map();
  for (const r of rows) {
    let prevs = [];
    try { prevs = JSON.parse(r.prev_events ?? '[]'); } catch { prevs = []; }
    prevsOf.set(r.event_id, prevs);
    for (const p of prevs) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(r.event_id);
    }
  }
  room.extremityList = [];
  for (const r of rows) {
    room.eventIndex.set(r.event_id, {
      hash: tipHash, branch: tipBranch, alive: !children.has(r.event_id),
      origin_ts: r.origin_ts, depth: r.depth,
    });
    if (!children.has(r.event_id)) {
      room.extremityList.push({ eventId: r.event_id, branch: tipBranch });
    }
  }
}

// Full DAG replay: fold every event in depth order (parents always have
// smaller depth), applying authorized state events onto the running map;
// merge events resolve across their parents' folded states via the shared
// rulebook — a conflict throws M_UNRESOLVED_CONFLICT. Returns
// {rows, refused} where rows are materialization inputs. The image's own
// `state` table is NEVER trusted (a forged conflict-free row is dropped
// by construction — state comes only from validated events).
async function replayDag(allPdus) {
  const byId = new Map(allPdus.map((e) => [e.event_id, e]));
  const createEvt = allPdus.find((e) => e.type === 'm.room.create' && (e.prev_events ?? []).length === 0);
  const createEventId = createEvt?.event_id;
  if (!createEventId) throw new Error('M_NO_CREATE: image has no create');
  const getEvent = (id) => byId.get(id);
  const ordered = [...allPdus].sort((a, b) =>
    a.depth - b.depth || (a.event_id < b.event_id ? -1 : 1));
  const stateAt = new Map(); // eventId -> StateMap after that event
  for (const pdu of ordered) {
    const prevs = pdu.prev_events ?? [];
    for (const p of prevs) {
      if (!byId.has(p)) throw new Error('M_UNKNOWN_PREV: ' + p);
    }
    // id recompute (forgery check) + declared content hash + shape
    if (!isPduShape(pdu)) throw new Error('M_BAD_IMAGE: PDU shape');
    if (await eventIdFor(pdu, ROOM_VERSION) !== pdu.event_id) {
      throw new Error('M_BAD_IMAGE: event id does not recompute');
    }
    const { event_id: _drop, ...noId } = pdu;
    if (await contentHashOf(noId) !== pdu.hashes?.sha256) {
      throw new Error('M_BAD_IMAGE: content hash mismatch');
    }
    // Origin signature (key-is-name): key-named senders must verify;
    // unsigned-or-bad from a key name refuses the image. DNS/legacy
    // names ride the channel (M5 verifies via /keys).
    const verdict = await verifyPeerSignature(pdu);
    if (verdict === 'bad-signature' || verdict === 'unsigned') {
      throw new Error('M_BAD_IMAGE: origin signature does not verify');
    }
    const parents = prevs.map((p) => stateAt.get(p) ?? new Map());
    const resolved = resolveState(parents); // throws on conflict
    const ctx = { stateAtPrevs: resolved, getEvent, createEventId };
    const next = new Map(resolved);
    // Rejected events stay in the DAG but out of state — and their
    // pass-through state MUST still be tracked, or descendants (and a
    // refused frontier tip) would resolve against an empty map and wipe
    // real state (every event gets a stateAt entry, always).
    let admitted = pdu.type === 'm.room.create';
    if (!admitted) {
      admitted = sameIdSet(pdu.auth_events ?? [], selectAuthEvents(pdu, ctx)) &&
        authorized(pdu, ctx) === 'ok';
    }
    if (admitted && pdu.state_key != null) {
      next.set(stateKeyOf(pdu.type, pdu.state_key), pdu.event_id);
    }
    stateAt.set(pdu.event_id, next);
  }
  const tips = allPdus.filter((e) => ![...byId.values()].some((o) => (o.prev_events ?? []).includes(e.event_id)));
  const tipStates = tips.map((t) => stateAt.get(t.event_id) ?? new Map());
  const final = resolveState(tipStates); // throws on fork conflict
  const rows = [];
  for (const [k, eid] of final) {
    const ep = byId.get(eid);
    const sep = k.indexOf('\0');
    rows.push({
      type: k.slice(0, sep), stateKey: k.slice(sep + 1), eventId: eid,
      content: ep.content ?? {},
    });
  }
  return { rows };
}

// Remote-adoption path (the dolt pull): write the peer's store image to a
// stable per-peer MEMFS file (in-place update — LB1-proven overwrite), fetch
// from it, then merge each named branch (dolt_branches does NOT enumerate
// remote refs — LB3b — so the sender names its alive branches explicitly).
// Empty local store (joiner) bootstraps via dolt_reset --hard onto the first
// named branch (LB3b), then moves to a working branch so main is never an
// extremity (main cannot be deleted — PB3).
//
// F0: adoption VALIDATES (id recompute of every adopted event from a probe
// of the image, cross-version refusal) then RE-RESOLVES via replayDag —
// and never crashes on a fork: on M_UNRESOLVED_CONFLICT the DAG stays
// adopted, state is restored to pre-adoption (contested keys
// unmaterialized), and the refusal is RETURNED (no throw escapes the
// pipeline). A forged conflict-free `state` row in the image is dropped
// (replay never reads image state).
export async function adoptStoreImage(room, bytes, peerId, branches) {
  const sqlite3 = await sqlite3Ready();
  const safe = String(peerId).replace(/[^A-Za-z0-9_-]/g, '_');
  const rname = `peer_${safe}`;
  const path = `/peer-${safe}.db`;
  sqlite3.capi.sqlite3_js_vfs_create_file('unix', path, bytes, bytes.byteLength);
  ensurePeerRemote(room, rname, path);
  // Probe the image BEFORE anything is observable: every event must
  // recompute its id, and the version must match (th.room_version).
  const probePath = `/probe-${crypto.randomUUID()}.db`;
  sqlite3.capi.sqlite3_js_vfs_create_file('unix', probePath, bytes, bytes.byteLength);
  const probe = new sqlite3.oo1.DB(probePath);
  try {
    // A fresh open lands on main (genesis only) — read the events union
    // across the image's x* extremity branches.
    const xbranches = probe.selectObjects(`SELECT name FROM dolt_branches`)
      .map((r) => r.name).filter((n) => typeof n === 'string' && n.startsWith('x')).sort();
    const imageEvents = [];
    const seenIds = new Set();
    for (const b of xbranches) {
      probe.exec(`SELECT dolt_checkout('${b}')`);
      for (const r of probe.selectObjects(`SELECT canonical_json FROM events`)) {
        const ev = JSON.parse(r.canonical_json);
        if (!seenIds.has(ev.event_id)) {
          seenIds.add(ev.event_id);
          imageEvents.push(ev);
        }
      }
    }
    for (const ev of imageEvents) {
      if (!isPduShape(ev)) return { applied: false, refused: 'M_BAD_IMAGE: PDU shape' };
      let expect;
      try {
        expect = await eventIdFor(ev, ROOM_VERSION);
      } catch {
        return { applied: false, refused: 'M_BAD_IMAGE: event id' };
      }
      if (expect !== ev.event_id) return { applied: false, refused: 'M_BAD_IMAGE: event id' };
      const { event_id: _drop, ...noId } = ev;
      if (await contentHashOf(noId) !== ev.hashes?.sha256) {
        return { applied: false, refused: 'M_BAD_IMAGE: content hash' };
      }
      const verdict = await verifyPeerSignature(ev);
      if (verdict === 'bad-signature' || verdict === 'unsigned') {
        return { applied: false, refused: 'M_BAD_IMAGE: origin signature' };
      }
    }
    const imageCreate = imageEvents.find((e) =>
      e.type === 'm.room.create' && (e.prev_events ?? []).length === 0);
    const imageVersion = imageCreate?.content?.room_version;
    if (room.eventIndex.size > 0 && imageVersion !== ROOM_VERSION) {
      return { applied: false, refused: 'M_WRONG_VERSION: cross-version image' };
    }
    if (room.eventIndex.size === 0 && imageVersion && imageVersion !== ROOM_VERSION) {
      return { applied: false, refused: 'M_WRONG_VERSION: cross-version image' };
    }
  } finally {
    probe.close();
  }
  const preRows = readStateRows(room.db);
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
  // Re-resolve from the DAG (never trust the image's state table).
  const allPdus = room.db.selectObjects(`SELECT canonical_json FROM events`)
    .map((r) => JSON.parse(r.canonical_json));
  try {
    const { rows } = await replayDag(allPdus);
    materialize(room.db, rows);
    try {
      room.db.selectValue(`SELECT dolt_commit('-Am','adopt: re-resolved ${allPdus.length} events')`);
    } catch (e) {
      if (!/nothing to commit/i.test(e.message)) throw e;
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    // Refusals restore pre-adoption state and surface (no throw escapes
    // the pipeline): fork conflicts AND bad images (forgery) alike.
    const m = /M_UNRESOLVED_CONFLICT/.test(msg)
      ? 'M_UNRESOLVED_CONFLICT'
      : /M_BAD_IMAGE/.test(msg)
      ? 'M_BAD_IMAGE'
      : null;
    if (!m) throw e;
    // Adopt the DAG, leave the contested keys unmaterialized: restore
    // pre-adoption state on the merged tip and surface the refusal.
    materialize(room.db, preRows);
    try {
      room.db.selectValue(`SELECT dolt_commit('-Am','adopt: refused (fork); DAG kept, state held')`);
    } catch (e2) {
      if (!/nothing to commit/i.test(e2.message)) throw e2;
    }
    rebuildIndex(room);
    room.refusals++;
    return { applied: true, refused: m };
  }
  rebuildIndex(room);
  return { applied: true };
}

// Read the x-branch list out of a store IMAGE (probe — a peer image's alive
// extremity tips; used when the transport's binary path can't carry the
// branch list, i.e. trysteros's synthetic t:'bin' envelope).
export async function branchesInImage(bytes) {
  const sqlite3 = await sqlite3Ready();
  const path = `/probe-${crypto.randomUUID()}.db`;
  sqlite3.capi.sqlite3_js_vfs_create_file('unix', path, bytes, bytes.byteLength);
  const db = new sqlite3.oo1.DB(path);
  try {
    return db.selectObjects(`SELECT name FROM dolt_branches`)
      .map((r) => r.name).filter((n) => /^x\d+$/.test(n)).sort();
  } finally {
    db.close();
  }
}

export function rawQuery(room, sql) {
  if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
    throw new Error('read-only: only SELECT/PRAGMA allowed in this console');
  }
  const columns = [];
  const rows = room.db.exec({ sql, returnValue: 'resultRows', columnNames: columns });
  return { columns, rows };
}
