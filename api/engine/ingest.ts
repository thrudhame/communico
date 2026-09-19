import type pgpkg from 'pg';
import { branchNameFor, ident, serverDb, withDb } from './db.ts';
import { extremities, lookupRoom, type RoomInfo } from './room.ts';
import { mergeDriver } from './mergedriver.ts';
import { eventIdFor } from './eventid.ts';
import { assertCanonicalNumbers, canonicalJson } from './canonical.ts';
import { MatrixError } from './matrix-error.ts';
import { signPdu, verifyPduSignature } from './signing.ts';
import { getTenantKey } from './tenant.ts';
import {
  materialize,
  publishCurrentState,
  type StateRowInput,
} from './materialize.ts';
import { getRulebook, stateKeyOf, type StateMap } from './policy.ts';
import type { Pdu } from './pdu.ts';
import {
  b32decode,
  contentHashOf,
  importPublicKeyFromRaw,
  isKeyName,
} from '#engine/signing-primitives.js';

export interface IngestResult {
  event_id: string;
  commit_hash: string;
}

export interface IngestOptions {
  // TEST HOOK ONLY (phase-2 fork test): skip deleting consumed prev
  // branches in step 8 so a second event can reference the same prev.
  keepPrevBranches?: boolean;
  // M4: transaction idempotency — the sending device + txn id, recorded
  // on the event_index row (unsigned.transaction_id renders for the same
  // device only).
  txn?: { deviceId: string; txnId: string };
}

// Core→hat signal (design §3.6: hats are plugins — the core knows nothing
// about them; hats subscribe). Emitted once per applied event, after the
// event_index row lands.
export type AppliedListener = (roomId: string, eventId: string) => void;
const appliedListeners = new Set<AppliedListener>();
export function onEventApplied(l: AppliedListener): () => void {
  appliedListeners.add(l);
  return () => appliedListeners.delete(l);
}

// E5 — per-room mutex: an in-process async lock keyed by room id.
// ingestEvent holds it from prev resolution through publishCurrentState;
// authorAndIngest holds it across author() AND ingest (band C §0) — the
// extremity read in author() and the publish that consumes it are one
// critical section, so a concurrent op always authors on the live tip.
// Complement subtests are t.Parallel() on one room; single process, one
// listener — a module-level Map<roomId, Promise> chain is sufficient.
const roomLocks = new Map<string, Promise<void>>();
async function withRoomLock<T>(
  roomId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = roomLocks.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  roomLocks.set(roomId, prev.then(() => mine));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (roomLocks.get(roomId) === mine) roomLocks.delete(roomId);
  }
}

export interface AuthorPartial {
  type: string;
  sender: string;
  content: unknown;
  state_key?: string;
  prev_events?: string[];
  origin_server_ts?: number;
}

function assertHash(s: string): void {
  if (!/^[a-z0-9]+$/i.test(s)) throw new Error('E_BAD_HASH: ' + s);
}

function parseStoredPdu(v: unknown): Pdu {
  if (typeof v === 'string') return JSON.parse(v) as Pdu;
  return v as Pdu;
}

// M3: the EventStore covers the FULL ancestry — resolution walks auth
// chains arbitrarily deep, so every event reachable from the parent
// commits is loaded, with its rejected flag (S4 155-164: chain-rejected
// events are excluded by the rulebook via isRejected).
interface AncestryStore {
  pduById: Map<string, Pdu>;
  rejectedIds: Set<string>;
}

async function loadAncestry(
  dbName: string,
  hashes: string[],
): Promise<AncestryStore> {
  const pduById = new Map<string, Pdu>();
  const rejectedIds = new Set<string>();
  await withDb(dbName, async (c) => {
    for (const h of hashes) {
      assertHash(h);
      const r = await c.query(
        `SELECT event_id, canonical_json, rejected FROM events AS OF '${h}';`,
      );
      // deno-lint-ignore no-explicit-any
      for (const row of r.rows as any[]) {
        const id = String(row.event_id);
        if (pduById.has(id)) continue;
        pduById.set(id, parseStoredPdu(row.canonical_json));
        if (row.rejected === true) rejectedIds.add(id);
      }
    }
  });
  return { pduById, rejectedIds };
}

function eventStoreOf(
  pduById: Map<string, Pdu>,
  rejectedIds: Set<string>,
): import('./rulebook/types.ts').EventStore {
  return {
    get: (id) => pduById.get(id),
    isRejected: (id) => rejectedIds.has(id),
  };
}

async function parentStateAt(dbName: string, hash: string): Promise<StateMap> {
  assertHash(hash);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT type, state_key, event_id FROM state AS OF '${hash}';`,
    );
    const m: StateMap = new Map();
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      m.set(
        stateKeyOf(String(row.type), String(row.state_key ?? '')),
        String(row.event_id),
      );
    }
    return m;
  });
}

// event_index lookup: the commit an event landed on (null if unknown).
async function commitHashOf(
  roomId: string,
  eventId: string,
): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const row = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return row.rows.length ? String(row.rows[0].commit_hash) : null;
  });
}

// State-map -> state rows (contents from validated PDUs only — a state
// row without a validated event behind it is never written).
function stateRowsOf(
  map: StateMap,
  pduById: Map<string, Pdu>,
): StateRowInput[] {
  const rows: StateRowInput[] = [];
  for (const [k, eid] of map) {
    const ep = pduById.get(eid);
    if (!ep) throw new Error('E_STATE_EVENT_MISSING: ' + eid);
    const sep = k.indexOf('\0');
    rows.push({
      type: k.slice(0, sep),
      stateKey: k.slice(sep + 1),
      eventId: eid,
      content: ep.content ?? {},
    });
  }
  return rows;
}

async function prevDepths(
  dbName: string,
  prevs: { id: string; commitHash: string }[],
): Promise<number[]> {
  const out: number[] = [];
  await withDb(dbName, async (c) => {
    for (const p of prevs) {
      assertHash(p.commitHash);
      const r = await c.query(
        `SELECT depth FROM events AS OF '${p.commitHash}' WHERE event_id = $1;`,
        [p.id],
      );
      if (r.rows.length === 0) throw new Error('M_UNKNOWN_PREV: ' + p.id);
      out.push(Number(r.rows[0].depth));
    }
  });
  return out;
}

async function resolvePrevs(
  roomId: string,
  prevIds: string[],
): Promise<{ id: string; commitHash: string; branch: string | null }[]> {
  const prevs: { id: string; commitHash: string; branch: string | null }[] = [];
  await withDb(serverDb(), async (c) => {
    if (prevIds.length === 0) return;
    const r = await c.query(
      'SELECT event_id, commit_hash, branch_name FROM event_index WHERE room_id = $1 AND event_id = ANY($2);',
      [roomId, prevIds],
    );
    // deno-lint-ignore no-explicit-any
    const byId = new Map<string, any>(
      // deno-lint-ignore no-explicit-any
      r.rows.map((row: any) => [String(row.event_id), row] as [string, any]),
    );
    for (const pid of prevIds) {
      const row = byId.get(pid);
      if (!row) throw new Error('M_UNKNOWN_PREV: ' + pid);
      prevs.push({
        id: pid,
        commitHash: String(row.commit_hash),
        branch: row.branch_name == null ? null : String(row.branch_name),
      });
    }
  });
  return prevs;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Local authoring: build the full PDU (depth, auth_events), content-hash,
// reference-hash id, redact-then-sign with the server key — then the same
// ingest path as remote events. selected auth_events come from the one
// shared rule (policy slot); ids minted here are stub-era ids.
export async function author(
  roomId: string,
  partial: AuthorPartial,
): Promise<Pdu> {
  // D9: non-canonical numbers in content are a client fault (400
  // M_BAD_JSON, spec appendices § Canonical JSON) — refused before
  // signing, whose canonical pass throws plain Errors (would 500).
  assertCanonicalNumbers(partial.content);
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
  const prevIds = partial.prev_events ??
    (await extremities(room.dbName, roomId)).map((e) => e.eventId);
  if (prevIds.length > 20) {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  const isCreate = partial.type === 'm.room.create' && prevIds.length === 0;
  const prevs = await resolvePrevs(roomId, prevIds);
  const depths = await prevDepths(room.dbName, prevs);
  const depth = prevs.length === 0 ? 1 : Math.max(...depths) + 1;

  const parentSets: StateMap[] = [];
  for (const p of prevs) {
    parentSets.push(await parentStateAt(room.dbName, p.commitHash));
  }
  const hashes = prevs.map((p) => p.commitHash);
  const ancestry = await loadAncestry(room.dbName, hashes);
  const store = eventStoreOf(ancestry.pduById, ancestry.rejectedIds);
  // Resolution first: concurrent state edits RESOLVE (M3 — the real v2
  // algorithm; the refusing stub is gone).
  const resolved = rulebook.resolveState(parentSets, store);

  let createEventId: string;
  if (isCreate) {
    createEventId = '';
  } else {
    const found = resolved.get(stateKeyOf('m.room.create', ''));
    if (!found) throw new Error('M_NO_CREATE: resolved state has no create');
    createEventId = found;
  }
  const pdu: Pdu = {
    type: partial.type,
    room_id: roomId,
    sender: partial.sender,
    content: (partial.content ?? {}) as Record<string, unknown>,
    prev_events: [...prevIds],
    auth_events: isCreate ? [] : rulebook.selectAuthEvents(
      {
        type: partial.type,
        sender: partial.sender,
        state_key: partial.state_key,
        content: (partial.content ?? {}) as Record<string, unknown>,
      } as Pdu,
      resolved,
    ),
    depth,
    origin_server_ts: partial.origin_server_ts ?? Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
  const key = await getTenantKey();
  await signPdu(pdu, room.roomVersion, key);
  // D9: the complete event — canonical-encoded, signatures included —
  // MUST NOT exceed 65536 bytes (spec client-server-api § Size limits,
  // v1.16 _index.md lines 2867-2883). Enforced in author() so /send and
  // PUT /state are both covered.
  if (new TextEncoder().encode(canonicalJson(pdu)).length > 65536) {
    throw new MatrixError(
      413,
      'M_TOO_LARGE',
      'event exceeds the 65536-byte limit',
    );
  }
  if (isCreate) {
    // self-reference resolved post-id (create carries no auth_events).
    void createEventId;
  }
  return pdu;
}

// E4 helper — delete a prev's branch, then walk back through
// soft-failed/rejected ancestors: a flagged event never consumed its own
// prevs, so their branches may still be live; an accepted event already
// consumed its prevs at ingest time, so the walk stops there. Runs on the
// room client `c` (the new branch is checked out — the stored PDUs of the
// whole cited ancestry are readable); event_index supplies branches/flags.
async function consumeBranchChain(
  c: pgpkg.Client,
  roomId: string,
  prev: { id: string; branch: string | null },
): Promise<void> {
  if (prev.branch !== null) {
    await c.query(`SELECT DOLT_BRANCH('-D', '${ident(prev.branch)}');`);
  }
  const flagged = await withDb(serverDb(), async (s) => {
    const r = await s.query(
      'SELECT rejected, soft_failed FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, prev.id],
    );
    return r.rows.length > 0 &&
      (r.rows[0].rejected === true || r.rows[0].soft_failed === true);
  });
  if (!flagged) return;
  const gp = await c.query(
    'SELECT prev_events FROM events WHERE event_id = $1;',
    [prev.id],
  );
  if (gp.rows.length === 0) return;
  const raw = gp.rows[0].prev_events;
  // jsonb arrives pre-parsed (array) via pg
  const ids: string[] = Array.isArray(raw) ? raw : JSON.parse(String(raw));
  const liveRows = await c.query('SELECT name FROM dolt.branches;');
  const live = new Set(
    // deno-lint-ignore no-explicit-any
    (liveRows.rows as any[]).map((b) => String(b.name)),
  );
  for (const id of ids) {
    const branch = await withDb(serverDb(), async (s) => {
      const r = await s.query(
        'SELECT branch_name FROM event_index WHERE room_id = $1 AND event_id = $2;',
        [roomId, id],
      );
      return r.rows.length && r.rows[0].branch_name != null
        ? String(r.rows[0].branch_name)
        : null;
    });
    // already consumed (null) or stale row — only consume live branches
    if (branch === null || !live.has(branch)) continue;
    await consumeBranchChain(c, roomId, { id, branch });
  }
}

// Steps 1-5 of ingest, outside the per-room lock: room/version gate, wire
// bounds, self-certifying id, idempotent redelivery, hash + signature
// checks. 'early' carries the redelivery receipt; 'go' carries the
// IngestPrecheck for ingestEventLocked.
async function ingestPrechecks(
  roomId: string,
  pdu: Pdu,
): Promise<
  { kind: 'early'; result: IngestResult } | { kind: 'go'; pre: IngestPrecheck }
> {
  // 1. room + version gate (unknown -> never a default).
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  getRulebook(room.roomVersion);
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];

  // 2. wire bounds (spec PDU: <=20 prev_events, <=10 auth_events).
  if (prevIds.length > 20) {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  if (declaredAuth.length > 10) {
    throw new Error('M_TOO_MANY_AUTH_EVENTS: v11 allows at most 10');
  }

  // 3. self-certifying id (also enforces the canonical int range — a
  // ts=2^53 seize throws here, refused before anything is stored).
  let expect: string;
  try {
    expect = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      room.roomVersion,
    );
  } catch (e) {
    throw new Error('M_BAD_EVENT: ' + String(e));
  }
  if (expect !== pdu.event_id) {
    throw new Error('M_BAD_EVENT: event_id does not recompute');
  }
  const eventId = String(pdu.event_id);

  // Idempotent redelivery: content-hash ids make ingest naturally
  // idempotent — a known event returns its receipt instead of
  // double-inserting (at-least-once delivery from sync/held drains).
  // Note: same-id redelivery is NOT re-verified. Distinct ids are
  // distinct events; same-id bytes that differ can only differ in
  // non-hashed fields (signatures/unsigned) or redacted-away content —
  // interchangeable by redaction's design. The DAG keeps first-writer
  // bytes; nothing re-enters state through this path.
  const existing = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE event_id = $1;',
      [eventId],
    );
    return r.rows.length ? String(r.rows[0].commit_hash) : null;
  });
  if (existing) {
    return {
      kind: 'early',
      result: { event_id: eventId, commit_hash: existing },
    };
  }

  // 4. content hash (spec: fail -> the event is redacted before further
  // processing; F0 records it rejected — in the DAG, out of state).
  // The v11 wire form has no `event_id` field (it is the derived
  // reference hash, transported out-of-band); strip our annotation
  // before hashing, as at signing time.
  let hashOk = false;
  try {
    const { event_id: _drop, ...noId } = pdu as unknown as Record<
      string,
      unknown
    >;
    void _drop;
    hashOk = (await contentHashOf(noId)) === pdu.hashes?.sha256;
  } catch {
    hashOk = false;
  }

  // 5. origin signature, REQUIRED (F1: the unsigned-lite seam is
  // deleted — every engine signs). Entries under our own serverName()
  // verify against the tenant key; entries under a base32 server_name
  // verify key-is-name (browser homeservers — nothing to fetch).
  // Unsigned PDUs are refused, full stop.
  const sigEntries = Object.entries(pdu.signatures ?? {});
  let sigOk = false;
  if (sigEntries.length > 0) {
    const key = await getTenantKey();
    for (const [srv, keys] of sigEntries) {
      if (srv === key.serverName) {
        for (const kid of Object.keys(keys as Record<string, string>)) {
          if (
            await verifyPduSignature(pdu, key.publicKey, srv, kid)
          ) sigOk = true;
        }
      } else if (isKeyName(srv)) {
        const raw = b32decode(srv);
        if (!raw || raw.length !== 32) continue;
        const pub = await importPublicKeyFromRaw(raw);
        for (const kid of Object.keys(keys as Record<string, string>)) {
          if (
            await verifyPduSignature(pdu, pub as unknown as CryptoKey, srv, kid)
          ) sigOk = true;
        }
      }
    }
  }
  if (!sigOk) {
    throw new Error('M_UNAUTHORIZED: PDU signature missing or invalid');
  }

  return { kind: 'go', pre: { room, eventId, hashOk, sigOk } };
}

export async function ingestEvent(
  roomId: string,
  pdu: Pdu,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const r = await ingestPrechecks(roomId, pdu);
  if (r.kind === 'early') return r.result;
  // E5: from prev resolution (step 6) through publishCurrentState, ingest
  // holds the per-room lock. author() stays outside (pure).
  return await withRoomLock(roomId, async () => {
    return await ingestEventLocked(roomId, pdu, opts, r.pre);
  });
}

interface IngestPrecheck {
  room: RoomInfo;
  eventId: string;
  hashOk: boolean;
  sigOk: boolean;
}

// author + ingest as one op-level step, holding the per-room lock across
// BOTH (band C §0): author() reads the live extremities to pick prevs, so
// it must sit in the same critical section as the publish that consumes
// them — a concurrent op then always authors on the new tip, and the
// M4-era stale-prev retry loop is retired (the race it covered can no
// longer occur). The lock is not reentrant: this calls
// ingestPrechecks/ingestEventLocked directly, never ingestEvent.
export async function authorAndIngest(
  roomId: string,
  partial: AuthorPartial,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  return await withRoomLock(roomId, async () => {
    const pdu = await author(roomId, partial);
    const r = await ingestPrechecks(roomId, pdu);
    if (r.kind === 'early') return r.result;
    return await ingestEventLocked(roomId, pdu, opts, r.pre);
  });
}

// Steps 6-12 of ingest, inside the per-room lock (E5).
async function ingestEventLocked(
  roomId: string,
  pdu: Pdu,
  opts: IngestOptions,
  pre: IngestPrecheck,
): Promise<IngestResult> {
  const { room, eventId, hashOk, sigOk } = pre;
  const rulebook = getRulebook(room.roomVersion);
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];

  // 6. prev resolution via the server DB's event_index (D8: the extremity
  //    branch comes from event_index.branch_name, not recomputation).
  const prevs = await resolvePrevs(roomId, prevIds);

  // 7. depth check (genesis = 1: spec positive, empty prevs => 1).
  const depths = await prevDepths(room.dbName, prevs);
  const computedDepth = prevs.length === 0 ? 1 : Math.max(...depths) + 1;
  const depthOk = pdu.depth === computedDepth;

  // 8. parent states + the M3 EventStore over the full ancestry (contents,
  //    rejected flags — S8 check 4 needs the event's own auth events). The
  //    store must also cover the OTHER branches: the soft-fail check
  //    resolves the current state across all extremities, whose lineage
  //    may hold events absent from this event's parent lineage.
  const parentSets: StateMap[] = [];
  for (const p of prevs) {
    parentSets.push(await parentStateAt(room.dbName, p.commitHash));
  }
  const xbs = await extremities(room.dbName, roomId);
  const xbHashes: string[] = [];
  for (const xb of xbs) {
    const h = await commitHashOf(roomId, xb.eventId);
    if (h) xbHashes.push(h);
  }
  const hashes = [...new Set([...prevs.map((p) => p.commitHash), ...xbHashes])];
  const ancestry = await loadAncestry(room.dbName, hashes);
  ancestry.pduById.set(eventId, pdu);
  const store = eventStoreOf(ancestry.pduById, ancestry.rejectedIds);
  const isCreate = pdu.type === 'm.room.create' && prevIds.length === 0;

  // 9. resolve parents (M3: resolution ALWAYS returns — the v2
  //    algorithm).
  const resolved = rulebook.resolveState(parentSets, store);

  // 10. the S8 sequence (server-server-api.md 473-478):
  //   (a) authorization rules based on the event's auth events (rules 1-2)
  //       + the declared auth_events must equal the shared selection (rule
  //       2.2's determinism); failures of the earlier S8 checks (validity,
  //       signature, depth) surface as chain rejection as in F0.
  //   (b) authorization rules based on the state before the event
  //       (rules 3-10) -> 'state-reject'.
  //   (c) soft-fail: the same rules against the CURRENT room state (the
  //       resolved state across all forward extremities) — a failure here
  //       soft-fails the event (stored, not an extremity for authoring,
  //       excluded from the client-visible timeline; server-server-api.md
  //       604-621).
  let verdict: 'ok' | 'authchain-reject' | 'state-reject' | 'soft-fail' = 'ok';
  if (!hashOk || !sigOk || !depthOk) {
    verdict = 'authchain-reject';
  } else {
    const chain = rulebook.checkAuthChain(pdu, store);
    const selected = rulebook.selectAuthEvents(pdu, resolved);
    if (!chain.ok || (!isCreate && !sameIdSet([...declaredAuth], selected))) {
      verdict = 'authchain-reject';
    } else {
      const state = rulebook.checkAuthAgainstState(pdu, resolved, store);
      if (!state.ok) {
        verdict = 'state-reject';
      } else {
        // (c) current room state: resolve across the live extremities
        // (the incoming event is not one of them yet); their commit
        // hashes are already in the store's ancestry load above.
        const xbSets: StateMap[] = [];
        for (const h of xbHashes) {
          xbSets.push(await parentStateAt(room.dbName, h));
        }
        const currentRoomState = rulebook.resolveState(xbSets, store);
        const current = rulebook.checkAuthAgainstState(
          pdu,
          currentRoomState,
          store,
        );
        if (!current.ok) verdict = 'soft-fail';
      }
    }
  }
  const rejected = verdict === 'authchain-reject' || verdict === 'state-reject';
  const softFailed = verdict === 'soft-fail';

  // 11. resolved state rows (contents from validated PDUs only — a state
  //    row without a validated event behind it is never written).
  const rows = stateRowsOf(resolved, ancestry.pduById);
  if (!rejected && pdu.state_key != null) {
    const at = rows.findIndex((r) =>
      r.type === String(pdu.type) && r.stateKey === String(pdu.state_key)
    );
    const row: StateRowInput = {
      type: String(pdu.type),
      stateKey: String(pdu.state_key),
      eventId,
      content: pdu.content ?? {},
    };
    if (at >= 0) rows[at] = row;
    else rows.push(row);
  }

  const { commitHash, newBranch } = await withDb(room.dbName, async (c) => {
    // D6: every operation that may merge sets this right after connecting;
    // the whole merge->resolve->commit sequence stays on this one client.
    await c.query('SET dolt_allow_commit_conflicts = 1;');

    // prev branch must be a live extremity, and the D8 invariant must
    // hold (branch tip == the event's commit)
    const branchRows = await c.query('SELECT name FROM dolt.branches;');
    const branchNames = new Set(
      branchRows.rows.map((r: { name: string }) => String(r.name)),
    );
    for (const p of prevs) {
      if (p.branch === null || !branchNames.has(p.branch)) {
        throw new Error('M_PREV_NOT_EXTREMITY: ' + p.id);
      }
      const h = await c.query(
        `SELECT (SELECT HASHOF('${ident(p.branch)}')) AS h;`,
      );
      if (String(h.rows[0].h) !== p.commitHash) {
        throw new Error('E_BRANCH_POINTER_DRIFT: ' + p.id);
      }
    }

    // base checkout, then D8 branch-first: create + check out the NEW
    // extremity branch BEFORE any merge or write — ingest NEVER commits
    // while a prev branch is checked out, so prev pointers never move.
    // N prevs chain as 2-parent commits (bookkeeping); the event DAG
    // keeps all N in prev_events, and resolution ran over the full set.
    if (prevs.length === 0) {
      await c.query(`SELECT DOLT_CHECKOUT('main');`);
    } else {
      await c.query(`SELECT DOLT_CHECKOUT('${ident(prevs[0].branch!)}');`);
    }
    const newBranch = await branchNameFor(eventId);
    await c.query(`SELECT DOLT_CHECKOUT('-b', '${ident(newBranch)}');`);
    // N-way fan-in chains 2-parent commits on the new branch (Dolt holds
    // one active merge at a time — each merge but the last is committed
    // as bookkeeping; only the final commit carries the event and is
    // indexed). The event DAG keeps all N in prev_events, and resolution
    // already ran over the full parent set.
    const fanin = prevs.slice(1);
    for (let i = 0; i < fanin.length; i++) {
      await mergeDriver(c, ident(fanin[i].branch!));
      if (i < fanin.length - 1) {
        try {
          await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
            `fan-in ${i + 2}/${prevs.length} for ${eventId}`,
          ]);
        } catch (e) {
          // a fast-forward merge (the merged branch descends from the
          // current head) leaves nothing to commit — that is fine; the
          // next merge or the final commit carries on
          if (!String(e).includes('nothing to commit')) throw e;
        }
      }
    }

    // event row: the received PDU stored VERBATIM as canonical text,
    // plus indexed columns (depth, prev/auth events, hashes,
    // signatures, rejected, soft_failed). canonical_json is text, not jsonb.
    await c.query(
      'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
      [
        eventId,
        pdu.type,
        pdu.state_key ?? null,
        pdu.sender,
        pdu.origin_server_ts,
        pdu.depth,
        JSON.stringify(prevIds),
        JSON.stringify(declaredAuth),
        JSON.stringify(pdu.hashes ?? {}),
        JSON.stringify(pdu.signatures ?? {}),
        rejected,
        softFailed,
        canonicalJson(pdu as unknown as Record<string, unknown>),
      ],
    );
    // State is the resolver's materialized cache: the ONLY writer is
    // materialize() (the phase-gate grep proves it). Messages copy the
    // resolved parent state unchanged; rejected events never enter it.
    await materialize(c, rows);

    // commit on the NEW branch (parameterized message)
    const msg = `event ${eventId} type ${String(pdu.type)}`;
    const res = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [msg]);
    let commitHash = res.rows[0]
      ? String(Object.values(res.rows[0])[0] ?? '')
      : '';
    if (commitHash === '') {
      const h = await c.query(`SELECT HASHOF('HEAD');`);
      commitHash = String(Object.values(h.rows[0])[0]);
    }

    // E4 — Synapse persist_events.py:1052-1111 (_calculate_new_extremities):
    // only ACCEPTED events consume prevs and become extremities. A
    // soft-failed/rejected event's branch exists (event history) but its
    // prevs stay live. When an accepted event cites a soft-failed/rejected
    // prev, consume that prev and walk back through soft-failed/rejected
    // ancestors (dangling-extremity handling). main is never an extremity
    // and stays at the schema-genesis commit.
    if (!rejected && !softFailed && !opts.keepPrevBranches) {
      for (const p of prevs) await consumeBranchChain(c, roomId, p);
    }
    return { commitHash, newBranch };
  });

  // event_id <-> commit_hash bijection + current branch (D8), flagged
  // rejected/soft-failed as the S8 checks decided (prev resolution needs
  // the id; rejected/soft-failed events still persist verbatim).
  await withDb(serverDb(), async (c) => {
    await c.query(
      'INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed, txn_device, txn_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);',
      [
        eventId,
        roomId,
        commitHash,
        newBranch,
        rejected,
        softFailed,
        opts.txn?.deviceId ?? null,
        opts.txn?.txnId ?? null,
      ],
    );
  });

  // 12. republish the room's current state on `main`: resolve across the
  //     post-event extremity set (extremities() reads the flags just
  //     written, so a rejected/soft-failed event is excluded and consumed
  //     prevs are gone). The store already covers every pre-existing
  //     extremity's ancestry (step 8) plus this pdu.
  const after = await extremities(room.dbName, roomId);
  const afterSets: StateMap[] = [];
  for (const xb of after) {
    const h = await commitHashOf(roomId, xb.eventId);
    if (h) afterSets.push(await parentStateAt(room.dbName, h));
  }
  const current = rulebook.resolveState(afterSets, store);
  const publishedRows = stateRowsOf(current, ancestry.pduById);
  const stateHash = await publishCurrentState(
    room.dbName,
    publishedRows,
    `after ${eventId}`,
  );

  // E1/E2 — state history: record `main`'s hash right after the publish
  // as this event's state pointer ("state at seq N" = state AS OF the
  // state_commit_hash of the last R-event with seq <= N), and fold the
  // PUBLISHED current-state rows' m.room.member entries into the per-user
  // membership index (a derived cache of `main`, same writer step).
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE event_index SET state_commit_hash = $1 WHERE event_id = $2;',
      [stateHash, eventId],
    );
    for (const r of publishedRows) {
      if (r.type !== 'm.room.member') continue;
      await c.query(
        `INSERT INTO room_membership (room_id, user_id, membership, event_id, seq)
         VALUES ($1,$2,$3,$4,(SELECT seq FROM event_index WHERE event_id=$4))
         ON CONFLICT (room_id, user_id) DO UPDATE SET membership=EXCLUDED.membership, event_id=EXCLUDED.event_id, seq=EXCLUDED.seq;`,
        [
          roomId,
          r.stateKey,
          (r.content as { membership?: string }).membership ?? 'leave',
          r.eventId,
        ],
      );
    }
  });

  // core→hat signal, then return — or surface the rejection (the event is
  // in the DAG and flagged; soft-fail does NOT surface: the event is
  // valid, the server merely declines to relay it — server-server-api.md
  // 611-614).
  for (const l of appliedListeners) {
    try {
      l(roomId, eventId);
    } catch (e) {
      console.error('applied listener error:', e);
    }
  }
  if (verdict === 'authchain-reject') {
    throw new Error('M_AUTHCHAIN_REJECT: ' + eventId);
  }
  if (verdict === 'state-reject') {
    throw new Error('M_STATE_REJECT: ' + eventId);
  }
  return { event_id: eventId, commit_hash: commitHash };
}
