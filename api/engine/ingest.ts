import type pgpkg from 'pg';
import { branchNameFor, ident, serverDb, withDb } from './db.ts';
import {
  chapterHead,
  extremities,
  lookupRoom,
  membershipOf,
  type RoomInfo,
  serversInRoom,
} from './room.ts';
import { mergeDriver } from './mergedriver.ts';
import { eventIdFor, redact } from './eventid.ts';
import { assertCanonicalNumbers, canonicalJson } from './canonical.ts';
import { MatrixError } from './matrix-error.ts';
import { config, serverName } from './config.ts';
import { localpartOf } from './auth.ts';
import { migrateRoomRules } from './pushrules.ts';
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
import { getVerifyKey } from './federation/keys.ts';
import { checkRemoteFormat, domainOf } from './federation/pdu.ts';
import { writeRows as writeOutboxRows } from './federation/outbox.ts';

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
  // M5b: the event arrived over federation. Absent = authored here (the
  // strict local checks apply unchanged). origin = the delivering server;
  // onBehalfOf = accepted on another server's behalf (send_join /
  // send_leave / returned invite — outbox fan-out, commit 3); position =
  // 'after' (live, the /sync stream) | 'before' (fetched history, commit
  // 10) | 'evidence' (join snapshot / auth chains — held, never news).
  remote?: {
    origin: string;
    onBehalfOf?: true;
    position: 'after' | 'before' | 'evidence';
  };
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
// M5b: exported for the federation/ package — the transaction handler,
// the missing-prev chain and the join snapshot hold the room lock
// themselves and call the locked-internal entry points (the lock is NOT
// reentrant; network I/O never runs under it).
const roomLocks = new Map<string, Promise<void>>();
export async function withRoomLock<T>(
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
  // ≤10 m.room.redaction: the target id goes top-level on the PDU
  // (pdu_v6.yaml:27-30; plan D10). v11+ keeps it in content.
  redacts?: string;
  // D2: the create event is authored BEFORE the room DB/directory row
  // exists (the v12 room id is derived from it). The hint supplies the
  // rulebook for exactly that case; when the room row exists it wins.
  roomVersion?: string;
}

function assertHash(s: string): void {
  if (!/^[a-z0-9]+$/i.test(s)) throw new Error('E_BAD_HASH: ' + s);
}

function parseStoredPdu(v: unknown): Pdu {
  if (typeof v === 'string') return JSON.parse(v) as Pdu;
  return v as Pdu;
}

// Indexed search text of a PDU (search.md:27-32): body/name/topic only.
// Value is lower-cased with NUL → space (D1). null = not indexed.
export function searchTextOf(
  pdu: Pdu,
): { key: string; text: string } | null {
  const content = pdu.content ?? {};
  let key: string | null = null;
  let raw: string | null = null;
  if (pdu.type === 'm.room.message' && typeof content.body === 'string') {
    key = 'content.body';
    raw = content.body;
  } else if (pdu.type === 'm.room.name' && typeof content.name === 'string') {
    key = 'content.name';
    raw = content.name;
  } else if (pdu.type === 'm.room.topic') {
    raw = topicTextOf(content);
    if (raw !== null) key = 'content.topic';
  }
  if (key === null || raw === null) return null;
  return { key, text: raw.replaceAll('\u0000', ' ').toLowerCase() };
}

function topicTextOf(content: Record<string, unknown>): string | null {
  const mTopic = content['m.topic'];
  if (mTopic !== null && typeof mTopic === 'object' && !Array.isArray(mTopic)) {
    const mText = (mTopic as Record<string, unknown>)['m.text'];
    if (Array.isArray(mText)) {
      for (const entry of mText) {
        if (
          entry === null || typeof entry !== 'object' || Array.isArray(entry)
        ) continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec.body !== 'string') continue;
        if (rec.mimetype === undefined || rec.mimetype === 'text/plain') {
          return rec.body;
        }
      }
    }
  }
  return typeof content.topic === 'string' ? content.topic : null;
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
): Promise<
  {
    id: string;
    commitHash: string;
    branch: string | null;
    era: string | null;
  }[]
> {
  const prevs: {
    id: string;
    commitHash: string;
    branch: string | null;
    era: string | null;
  }[] = [];
  await withDb(serverDb(), async (c) => {
    if (prevIds.length === 0) return;
    const r = await c.query(
      'SELECT event_id, commit_hash, branch_name, era, rejected_reason FROM event_index WHERE room_id = $1 AND event_id = ANY($2);',
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
      // M5b (ruling B): an ungrounded prev does not ground children — its
      // state is a placeholder, not history; nor does an 'unverifiable'
      // one (its auth chain could not be fetched — TestCorruptedAuthChain).
      // A child citing either is unknown for grounding and goes the same
      // way. Prevs rejected for 'auth'/'state' ARE grounding (their state
      // is real).
      if (
        row.rejected_reason === 'ungrounded' ||
        row.rejected_reason === 'unverifiable'
      ) {
        throw new Error('M_UNKNOWN_PREV: ' + pid);
      }
      prevs.push({
        id: pid,
        commitHash: String(row.commit_hash),
        branch: row.branch_name == null ? null : String(row.branch_name),
        era: row.era == null ? null : String(row.era),
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
  // D2: a create event may be authored before the room row exists (the
  // v12 room id derives from the create) — the version comes from the
  // hint then; every other path requires the row.
  const room = await lookupRoom(roomId);
  const roomVersion = room?.roomVersion ??
    (partial.type === 'm.room.create' && partial.roomVersion !== undefined
      ? partial.roomVersion
      : null);
  if (roomVersion === null) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(roomVersion);
  // D9: non-canonical numbers in content are a client fault (400
  // M_BAD_JSON, spec appendices § Canonical JSON) — refused before
  // signing, whose canonical pass throws plain Errors (would 500).
  // D7: the gate is strictness itself — v6+ enforces canonical JSON
  // (v6-canonical-json.md); ≤5 MUST NOT strictly enforce
  // (v1-canonical-json.md:2-4, appendices.md:103-110). Hashing still
  // canonicalises either way: local createRoom/send produce canonical
  // numbers — only acceptance relaxes (remote ingest is M5).
  if (rulebook.spec.strictCanonicalJson) {
    assertCanonicalNumbers(partial.content);
  }
  const prevIds = partial.prev_events ??
    (room
      ? (await extremities(room.dbName, roomId)).map((e) => e.eventId)
      : null);
  if (prevIds === null) {
    throw new Error(
      'E_AUTHOR_NO_ROOM: prev_events required when the room row is absent',
    );
  }
  if (prevIds.length > 20) {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  const isCreate = partial.type === 'm.room.create' && prevIds.length === 0;
  const prevs = await resolvePrevs(roomId, prevIds);
  const depths = room ? await prevDepths(room.dbName, prevs) : [];
  const depth = prevs.length === 0 ? 1 : Math.max(...depths) + 1;

  const parentSets: StateMap[] = [];
  if (room) {
    for (const p of prevs) {
      parentSets.push(await parentStateAt(room.dbName, p.commitHash));
    }
  }
  const hashes = prevs.map((p) => p.commitHash);
  const ancestry = room
    ? await loadAncestry(room.dbName, hashes)
    : { pduById: new Map<string, Pdu>(), rejectedIds: new Set<string>() };
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
  // D2: a v12 create carries NO room_id (v12.md:98-101 — the room ID is
  // the create's own event id); everything else carries it as today.
  if (!(rulebook.spec.roomIdFromCreateEvent && isCreate)) {
    pdu.room_id = roomId;
  }
  if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
  // D10: ≤10 redaction events carry the target id top-level
  // (pdu_v6.yaml:27-30).
  if (partial.redacts !== undefined) pdu.redacts = partial.redacts;
  const key = await getTenantKey();
  await signPdu(pdu, roomVersion, key);
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
  // D8: the depth bound (depth_v6.yaml:18-24 — 2^53-1 for v6+;
  // pdu_v4.yaml:32-35 — 2^63-1 for ≤5). Practically unreachable; the
  // check documents the flag.
  const depthBound = rulebook.spec.depthLimit === 'int53'
    ? 2 ** 53 - 1
    : 2 ** 63 - 1;
  if (depth > depthBound) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'event depth exceeds the room version limit',
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
// M5b (era isolation, §3.6a): a branch is consumed only when its event
// belongs to the CURRENT chapter — a post-re-join event citing an old-era
// prev branches from that commit but never deletes the archive's branch.
async function consumeBranchChain(
  c: pgpkg.Client,
  roomId: string,
  prev: { id: string; branch: string | null },
  currentChapter: string,
): Promise<void> {
  if (prev.branch !== null) {
    await c.query(`SELECT DOLT_BRANCH('-D', '${ident(prev.branch)}');`);
  }
  const flagged = await withDb(serverDb(), async (s) => {
    const r = await s.query(
      'SELECT rejected, soft_failed, era FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, prev.id],
    );
    return r.rows.length > 0 &&
      (r.rows[0].rejected === true || r.rows[0].soft_failed === true) &&
      String(r.rows[0].era ?? '') === currentChapter;
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
        'SELECT branch_name FROM event_index WHERE room_id = $1 AND event_id = $2 AND era = $3;',
        [roomId, id, currentChapter],
      );
      return r.rows.length && r.rows[0].branch_name != null
        ? String(r.rows[0].branch_name)
        : null;
    });
    // already consumed (null), another era's archive, or stale row —
    // only consume live branches of the current chapter
    if (branch === null || !live.has(branch)) continue;
    await consumeBranchChain(c, roomId, { id, branch }, currentChapter);
  }
}

// Steps 1-5 of ingest, outside the per-room lock: room/version gate, wire
// bounds, self-certifying id, idempotent redelivery, hash + signature
// checks. 'early' carries the redelivery receipt; 'go' carries the
// IngestPrecheck for ingestEventLocked. M5b: exported for the
// federation/ package — callers must hold the room lock (withRoomLock)
// before pairing this with ingestEventLocked.
export async function ingestPrechecks(
  roomId: string,
  pdu: Pdu,
  opts: IngestOptions = {},
): Promise<
  { kind: 'early'; result: IngestResult } | { kind: 'go'; pre: IngestPrecheck }
> {
  // 1. room + version gate (unknown -> never a default). For remote
  //    events the caller already made the room exist (join snapshot /
  //    provisioning), so M_ROOM_NOT_FOUND here is a bug, not a wire case.
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];

  // 2. wire bounds + the M5b remote format checks (SS:464-469, step 1
  //    "valid event"). Local events keep today's behaviour (author()
  //    enforces the caps it can violate); the remote additions run only
  //    for opts.remote.
  if (prevIds.length > 20 && opts.remote?.position !== 'before') {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  if (declaredAuth.length > 10 && opts.remote?.position !== 'before') {
    throw new Error('M_TOO_MANY_AUTH_EVENTS: v11 allows at most 10');
  }
  let oversized = false;
  if (opts.remote) {
    // M5b (SS:464-469, step 1 "valid event"): the remote format checks
    // live in federation/pdu.ts — a format failure is a drop (thrown), a
    // lenient-version per-key size failure comes back as 'oversized'.
    oversized = checkRemoteFormat(pdu, rulebook.spec, {
      exemptPrevAuthLimits: opts.remote.position === 'before',
    }).oversized;
  }
  // 3. `unsigned` stripped on receipt (not covered by signatures —
  //    appendices.md:341-343 — nor by the content hash, SS:1355-1361):
  //    we never store another server's unsigned. invite_room_state on an
  //    invite is read by §3.8 BEFORE this strip.
  delete (pdu as unknown as Record<string, unknown>).unsigned;

  // 4. self-certifying id (also enforces the canonical int range — a
  //    ts=2^53 seize throws here, refused before anything is stored).
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

  // D2 defence in depth: for a v12 create, the room ID must be the
  // create's own event id with ! for $ (v12.md:98-101, 108-109).
  if (
    room.roomVersion !== undefined &&
    getRulebook(room.roomVersion).spec.roomIdFromCreateEvent &&
    pdu.type === 'm.room.create' &&
    roomId !== '!' + eventId.slice(1)
  ) {
    throw new Error(
      'E_ROOM_ID_MISMATCH: v12 room id is not the create event id',
    );
  }

  // Idempotent redelivery: content-hash ids make ingest naturally
  // idempotent — a known event returns its receipt instead of
  // double-inserting (at-least-once delivery from sync/held drains).
  // Note: same-id redelivery is NOT re-verified. Distinct ids are
  // distinct events; same-id bytes that differ can only differ in
  // non-hashed fields (signatures/unsigned) or redacted-away content —
  // interchangeable by redaction's design. The DAG keeps first-writer
  // bytes; nothing re-enters state through this path.
  // M5b (ruling B): an 'ungrounded' placeholder re-delivered over
  // federation falls THROUGH for a real re-ingest (its index row is
  // updated in place; the placeholder branch is deleted before the
  // re-ingest creates it again).
  const existing = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash, rejected_reason FROM event_index WHERE event_id = $1;',
      [eventId],
    );
    return r.rows.length
      ? {
        commitHash: String(r.rows[0].commit_hash),
        rejectedReason: r.rows[0].rejected_reason == null
          ? null
          : String(r.rows[0].rejected_reason),
      }
      : null;
  });
  const redeliverUngrounded = existing !== null &&
    existing.rejectedReason === 'ungrounded' && opts.remote !== undefined;
  if (existing && !redeliverUngrounded) {
    return {
      kind: 'early',
      result: { event_id: eventId, commit_hash: existing.commitHash },
    };
  }

  // 5. content hash (spec: fail -> the event is redacted before further
  //    processing; F0 records it rejected — in the DAG, out of state).
  //    M5b (SS:471-472, SS:1328-1336): a REMOTE event whose hash fails is
  //    replaced by the redacted copy we calculate — today's
  //    hashOk=false -> authchain-reject is kept for local events only.
  //    The v11 wire form has no `event_id` field (it is the derived
  //    reference hash, transported out-of-band); strip our annotation
  //    before hashing, as at signing time.
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
  if (!hashOk && opts.remote) {
    const redacted = redact(
      pdu as unknown as Record<string, unknown>,
      room.roomVersion,
    );
    for (const k of Object.keys(pdu)) {
      delete (pdu as unknown as Record<string, unknown>)[k];
    }
    Object.assign(pdu, redacted);
    hashOk = true;
  }

  // 6. origin signature, REQUIRED (F1: the unsigned-lite seam is
  //    deleted — every engine signs). Entries under our own serverName()
  //    verify against the tenant key; entries under a base32 server_name
  //    verify key-is-name (browser homeservers — nothing to fetch).
  //    Unsigned PDUs are refused, full stop. (M5b commit 2: remote
  //    senders verify through getVerifyKey with the room's witnesses.)
  const sigEntries = Object.entries(pdu.signatures ?? {});
  let sigOk = false;
  if (sigEntries.length > 0) {
    const key = await getTenantKey();
    for (const [srv, keys] of sigEntries) {
      if (srv === key.serverName) {
        for (const kid of Object.keys(keys as Record<string, string>)) {
          if (
            await verifyPduSignature(
              pdu,
              key.publicKey,
              srv,
              kid,
              room.roomVersion,
            )
          ) sigOk = true;
        }
      } else if (isKeyName(srv)) {
        const raw = b32decode(srv);
        if (!raw || raw.length !== 32) continue;
        const pub = await importPublicKeyFromRaw(raw);
        for (const kid of Object.keys(keys as Record<string, string>)) {
          if (
            await verifyPduSignature(
              pdu,
              pub as unknown as CryptoKey,
              srv,
              kid,
              room.roomVersion,
            )
          ) sigOk = true;
        }
      }
    }
  }
  // 7. M5b (SS:470, step 2): a REMOTE event must carry a verifying
  //    signature from the SENDER'S server (SS:1318-1326; v11.md:85) —
  //    forwarding by any origin is allowed, so the spec names the
  //    sender's server, not the deliverer; signing is what binds. The
  //    key comes from the remembered-keys path with the room's servers
  //    as extra witnesses ({ roomId }); validity per the room version's
  //    enforceKeyValidity (v5-signing-requirements.md:2-16). A failure
  //    or an unobtainable key is a drop, never a deferral.
  if (!sigOk && opts.remote) {
    const senderDomain = domainOf(String(pdu.sender));
    const minValidUntil = rulebook.spec.enforceKeyValidity
      ? Number(pdu.origin_server_ts)
      : 0;
    for (const kid of Object.keys(pdu.signatures?.[senderDomain] ?? {})) {
      try {
        const key = await getVerifyKey(
          senderDomain,
          kid,
          minValidUntil,
          'event',
          { roomId },
        );
        if (
          await verifyPduSignature(
            pdu,
            key,
            senderDomain,
            kid,
            room.roomVersion,
          )
        ) {
          sigOk = true;
          break;
        }
      } catch {
        // key unobtainable under this id — try the next
      }
    }
  }
  if (!sigOk) {
    throw new Error('M_UNAUTHORIZED: PDU signature missing or invalid');
  }

  return {
    kind: 'go',
    pre: { room, eventId, hashOk, sigOk, oversized, redeliverUngrounded },
  };
}

export async function ingestEvent(
  roomId: string,
  pdu: Pdu,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const r = await ingestPrechecks(roomId, pdu, opts);
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
  // M5b: a lenient-version per-key size failure — stored rejected
  // 'oversized' (never a drop; strict versions throw in prechecks).
  oversized: boolean;
  // M5b (ruling B): an 'ungrounded' placeholder re-delivered over
  // federation — the index row is updated in place and the placeholder
  // branch deleted before the re-ingest creates it again.
  redeliverUngrounded: boolean;
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
    const r = await ingestPrechecks(roomId, pdu, opts);
    if (r.kind === 'early') return r.result;
    return await ingestEventLocked(roomId, pdu, opts, r.pre);
  });
}

// M5b (§3.2, D1, ruling B): an event whose prevs we lack is stored
// rejected 'ungrounded' — "couldn't check yet" is not a verdict (the
// spec has no such rejection; Dendrite stores it; Complement's
// TestUnrejectRejectedEvents requires a re-sent event to re-evaluate).
// The placeholder's own x* branch starts at the genesis commit (rejected
// events have branches and are not extremities); its `state` table is
// the room's current published state, documented as a placeholder (NOT
// grounding — spec SS:560-563 asks for "state calculated as normal",
// which is impossible without the prev). The row carries expires_ms
// (removed when past; a later delivery is then a first delivery) and the
// still-missing prev ids in event_index_waiting (the re-check lookup —
// P4 ruling). ungroundedmillihours = 0 = drop instead (Synapse's
// behaviour, chosen by the admin). The CALLER holds the room lock.
export async function storeUngroundedLocked(
  roomId: string,
  pdu: Pdu,
  origin: string,
): Promise<void> {
  if (config().federation.ungroundedmillihours === 0) {
    throw new Error(
      'M_UNKNOWN_PREV: ' + String((pdu.prev_events ?? [])[0] ?? ''),
    );
  }
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const eventId = String(pdu.event_id);
  const missingPrevIds: string[] = [];
  await withDb(serverDb(), async (c) => {
    // 'ungrounded'/'unverifiable' prevs count as MISSING for grounding —
    // their state is a placeholder, not history (ruling B)
    const r = await c.query(
      `SELECT event_id FROM event_index WHERE room_id = $1 AND event_id = ANY($2)
         AND (rejected_reason IS NULL OR rejected_reason NOT IN ('ungrounded', 'unverifiable'));`,
      [roomId, pdu.prev_events ?? []],
    );
    const known = new Set(
      // deno-lint-ignore no-explicit-any
      r.rows.map((row: any) => String(row.event_id)),
    );
    for (const pid of pdu.prev_events ?? []) {
      if (!known.has(pid)) missingPrevIds.push(pid);
    }
  });
  if (missingPrevIds.length === 0) {
    throw new Error('E_UNGROUNDED_NOTHING_MISSING: ' + eventId);
  }
  const newBranch = await branchNameFor(eventId);
  const commitHash = await withDb(room.dbName, async (c) => {
    assertHash(room.genesisCommit);
    await c.query(
      `SELECT DOLT_BRANCH('${ident(newBranch)}', '${room.genesisCommit}');`,
    );
    await c.query(`SELECT DOLT_CHECKOUT('${ident(newBranch)}');`);
    await c.query(
      'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
      [
        eventId,
        pdu.type,
        pdu.state_key ?? null,
        pdu.sender,
        pdu.origin_server_ts,
        pdu.depth,
        JSON.stringify(pdu.prev_events ?? []),
        JSON.stringify(pdu.auth_events ?? []),
        JSON.stringify(pdu.hashes ?? {}),
        JSON.stringify(pdu.signatures ?? {}),
        true, // rejected — a placeholder is never in state
        false,
        canonicalJson(pdu as unknown as Record<string, unknown>),
      ],
    );
    // the room's CURRENT published state as the placeholder's state table
    const head = await chapterHead(roomId);
    if (head !== null) {
      const tip = await c.query(`SELECT HASHOF('${ident(head)}') AS h;`);
      const stateRows = await c.query(
        `SELECT type, state_key, event_id, content FROM state AS OF '${
          String(tip.rows[0].h)
        }';`,
      );
      await materialize(
        c,
        // deno-lint-ignore no-explicit-any
        (stateRows.rows as any[]).map((r) => ({
          type: String(r.type),
          stateKey: String(r.state_key),
          eventId: String(r.event_id),
          content: typeof r.content === 'string'
            ? JSON.parse(r.content)
            : r.content,
        })),
      );
    }
    const res = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
      `ungrounded ${eventId} type ${String(pdu.type)}`,
    ]);
    return String(Object.values(res.rows[0])[0] ?? '');
  });
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
         rejected_reason, origin, expires_ms, added_ms, seq, era)
       VALUES ($1, $2, $3, $4, TRUE, FALSE, 'ungrounded', $5, $6, $7, NULL, NULL);`,
      [
        eventId,
        roomId,
        commitHash,
        newBranch,
        origin,
        Date.now() + config().federation.ungroundedmillihours * 3_600,
        Date.now(),
      ],
    );
    for (const missing of missingPrevIds) {
      await c.query(
        'INSERT INTO event_index_waiting (room_id, missing_prev, event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
        [roomId, missing, eventId],
      );
    }
  });
}

// M5b (§3.4): a prev fetched via /state_ids + /event lands 'after'
// (live — clients see it) with the FETCHED state as its before-state
// (the remote's state at the event — Synapse
// federation_event.py:1188-1230): one "pack" commit on the prev's own
// x* branch carries the fetched evidence events (so ancestry loading
// from the prev's lineage finds them and DOLT_GC never takes them —
// r5, fable), the prev's own commit rides on top with the fetched state
// applied. The caller holds the room lock.
export async function ingestPrevWithFetchedStateLocked(
  roomId: string,
  prev: Pdu,
  fetchedEvents: Pdu[],
  fetchedState: StateRowInput[],
  origin: string,
): Promise<IngestResult> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
  const eventId = String(prev.event_id);

  // auth of the prev against the fetched state (rules 3–10) and its
  // auth chain (rules 1–2) — the store covers the pack AND the room's
  // held history (the prev's auth events usually name events we hold)
  const fetchedMap: StateMap = new Map();
  for (const r of fetchedState) {
    fetchedMap.set(stateKeyOf(r.type, r.stateKey), r.eventId);
  }
  const pduById = new Map<string, Pdu>();
  // held history: the live extremities' commits carry every earlier
  // event on their lineages (the chapter's own commits hold only the
  // materialized state)
  const xbs = await extremities(room.dbName, roomId);
  const heldHashes: string[] = [];
  for (const xb of xbs) {
    const h = await commitHashOf(roomId, xb.eventId);
    if (h !== null) heldHashes.push(h);
  }
  if (heldHashes.length > 0) {
    const held = await loadAncestry(room.dbName, heldHashes);
    for (const [id, p] of held.pduById) pduById.set(id, p);
  }
  for (const e of fetchedEvents) pduById.set(String(e.event_id), e);
  pduById.set(eventId, prev);
  const store = eventStoreOf(pduById, new Set());
  const chain = rulebook.checkAuthChain(prev, store);
  let rejected = false;
  let rejectRule: string | null = null;
  if (!chain.ok) {
    rejected = true;
    rejectRule = chain.rule;
  } else {
    const st = rulebook.checkAuthAgainstState(prev, fetchedMap, store);
    if (!st.ok) {
      rejected = true;
      rejectRule = st.rule;
    }
  }
  const rejectedReason = rejected
    ? (rejectRule !== null && rejectRule.startsWith('3') ? 'state' : 'auth')
    : null;
  void rejectedReason;

  const { packCommit, prevCommit, xBranch } = await withDb(
    room.dbName,
    async (c) => {
      const xBranch = await branchNameFor(eventId);
      assertHash(room.genesisCommit);
      await c.query(
        `SELECT DOLT_BRANCH('${ident(xBranch)}', '${room.genesisCommit}');`,
      );
      await c.query(`SELECT DOLT_CHECKOUT('${ident(xBranch)}');`);
      // the pack: every fetched event on this lineage
      for (const e of fetchedEvents) {
        await c.query(
          'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
          [
            String(e.event_id),
            e.type,
            e.state_key ?? null,
            e.sender,
            e.origin_server_ts,
            e.depth,
            JSON.stringify(e.prev_events ?? []),
            JSON.stringify(e.auth_events ?? []),
            JSON.stringify(e.hashes ?? {}),
            JSON.stringify(e.signatures ?? {}),
            false,
            false,
            canonicalJson(e as unknown as Record<string, unknown>),
          ],
        );
      }
      await materialize(c, fetchedState);
      const pr = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
        `fetched state before ${eventId}`,
      ]);
      const packCommit = String(Object.values(pr.rows[0])[0] ?? '');
      // the prev itself
      await c.query(
        'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
        [
          eventId,
          prev.type,
          prev.state_key ?? null,
          prev.sender,
          prev.origin_server_ts,
          prev.depth,
          JSON.stringify(prev.prev_events ?? []),
          JSON.stringify(prev.auth_events ?? []),
          JSON.stringify(prev.hashes ?? {}),
          JSON.stringify(prev.signatures ?? {}),
          rejected,
          false,
          canonicalJson(prev as unknown as Record<string, unknown>),
        ],
      );
      const rows = [...fetchedState];
      if (!rejected && prev.state_key != null) {
        const at = rows.findIndex((r) =>
          r.type === String(prev.type) && r.stateKey === String(prev.state_key)
        );
        const row: StateRowInput = {
          type: String(prev.type),
          stateKey: String(prev.state_key),
          eventId,
          content: prev.content ?? {},
        };
        if (at >= 0) rows[at] = row;
        else rows.push(row);
      }
      await materialize(c, rows);
      const rr = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
        `event ${eventId} type ${String(prev.type)}`,
      ]);
      const prevCommit = String(Object.values(rr.rows[0])[0] ?? '');
      return { packCommit, prevCommit, xBranch };
    },
  );

  // index rows: the fetched events as 'evidence' at the pack commit
  // (seq NULL, no branch); the prev live (seq, era, branch)
  const currentChapter = room.currentChapter;
  await withDb(serverDb(), async (c) => {
    for (const e of fetchedEvents) {
      await c.query(
        `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
           rejected_reason, origin, added_ms, era, seq)
         VALUES ($1, $2, $3, NULL, FALSE, FALSE, NULL, $4, $5, NULL, NULL)
         ON CONFLICT (event_id) DO NOTHING;`,
        [String(e.event_id), roomId, packCommit, origin, Date.now()],
      );
    }
    await c.query(
      `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
         rejected_reason, origin, added_ms, era)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO UPDATE SET commit_hash = $3, branch_name = $4, rejected = $5, rejected_reason = $6, era = $9, seq = DEFAULT;`,
      [
        eventId,
        roomId,
        prevCommit,
        rejected ? null : xBranch,
        rejected,
        rejected
          ? (rejectRule !== null && rejectRule.startsWith('3')
            ? 'state'
            : 'auth')
          : null,
        origin,
        Date.now(),
        currentChapter,
      ],
    );
    await c.query(
      'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
  });
  const prevSeq = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT seq FROM event_index WHERE event_id = $1;',
      [
        eventId,
      ],
    );
    return r.rows[0].seq == null ? null : Number(r.rows[0].seq);
  });

  // publish + fold + the re-check trigger, as for any live event
  if (!rejected && currentChapter !== null) {
    const resolved = new Map(fetchedMap);
    if (prev.state_key != null) {
      resolved.set(
        stateKeyOf(String(prev.type), String(prev.state_key)),
        eventId,
      );
    }
    const publishedRows = stateRowsOf(resolved, pduById);
    const stateHash = await publishCurrentState(
      room.dbName,
      currentChapter,
      publishedRows,
      `after ${eventId}`,
    );
    await withDb(serverDb(), async (c) => {
      await c.query(
        'UPDATE event_index SET state_commit_hash = $1 WHERE event_id = $2;',
        [stateHash, eventId],
      );
    });
    await foldMembership(roomId, publishedRows, prev, prevSeq);
  }
  for (const l of appliedListeners) {
    try {
      l(roomId, eventId);
    } catch (e) {
      console.error('applied listener error:', e);
    }
  }
  if (rejected) {
    throw new Error(
      (rejectRule !== null && rejectRule.startsWith('3')
        ? 'M_STATE_REJECT: '
        : 'M_AUTHCHAIN_REJECT: ') +
        eventId +
        (rejectRule !== null ? ' (rule ' + rejectRule + ')' : ''),
    );
  }
  // ruling B: the pack grounds the prev — its waiters re-check (the same
  // tail the plain ingest path runs; without it a pack's children wait
  // for their expiry)
  if (!rejected || rejectedReason === 'auth' || rejectedReason === 'state') {
    const hasWaiters = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT 1 FROM event_index_waiting WHERE room_id = $1 AND missing_prev = $2 LIMIT 1;',
        [roomId, eventId],
      );
      return r.rows.length > 0;
    });
    if (hasWaiters) void queuePlaceholderRechecks(roomId);
  }
  return { event_id: eventId, commit_hash: prevCommit };
}

// M5b (§3.4, TestCorruptedAuthChain): an event whose auth events could
// not be fetched is stored rejected 'unverifiable' — the reference
// resolves, it is never rendered, and it grounds nothing (its state is
// unknowable). No expiry — a standing record, not a placeholder. The
// CALLER holds the room lock.
export async function storeUnverifiableLocked(
  roomId: string,
  pdu: Pdu,
  origin: string,
): Promise<void> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const eventId = String(pdu.event_id);
  const newBranch = await branchNameFor(eventId);
  const commitHash = await withDb(room.dbName, async (c) => {
    assertHash(room.genesisCommit);
    await c.query(
      `SELECT DOLT_BRANCH('${ident(newBranch)}', '${room.genesisCommit}');`,
    );
    await c.query(`SELECT DOLT_CHECKOUT('${ident(newBranch)}');`);
    await c.query(
      'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
      [
        eventId,
        pdu.type,
        pdu.state_key ?? null,
        pdu.sender,
        pdu.origin_server_ts,
        pdu.depth,
        JSON.stringify(pdu.prev_events ?? []),
        JSON.stringify(pdu.auth_events ?? []),
        JSON.stringify(pdu.hashes ?? {}),
        JSON.stringify(pdu.signatures ?? {}),
        true, // rejected
        false,
        canonicalJson(pdu as unknown as Record<string, unknown>),
      ],
    );
    // the room's current published state as a marker state table — this
    // is NOT grounding (groundingOf answers 'placeholder' for it)
    const head = await chapterHead(roomId);
    if (head !== null) {
      const tip = await c.query(`SELECT HASHOF('${ident(head)}') AS h;`);
      const stateRows = await c.query(
        `SELECT type, state_key, event_id, content FROM state AS OF '${
          String(tip.rows[0].h)
        }';`,
      );
      await materialize(
        c,
        // deno-lint-ignore no-explicit-any
        (stateRows.rows as any[]).map((r) => ({
          type: String(r.type),
          stateKey: String(r.state_key),
          eventId: String(r.event_id),
          content: typeof r.content === 'string'
            ? JSON.parse(r.content)
            : r.content,
        })),
      );
    }
    const res = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
      `unverifiable ${eventId} type ${String(pdu.type)}`,
    ]);
    return String(Object.values(res.rows[0])[0] ?? '');
  });
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
         rejected_reason, origin, added_ms, seq, era)
       VALUES ($1, $2, $3, $4, TRUE, FALSE, 'unverifiable', $5, $6, NULL, NULL)
       ON CONFLICT (event_id) DO NOTHING;`,
      [eventId, roomId, commitHash, newBranch, origin, Date.now()],
    );
  });
}

// --- ruling B: the placeholder re-check driver -------------------------------

// After ANY event gains real grounding — accepted, or stored rejected
// for 'auth'/'state' (those have real state and do ground children) —
// ingest looks up placeholders waiting for it (one indexed SELECT on the
// side table — P4 ruling) and queues the room's driver. Re-checks run
// AFTER the current lock is released (each is a normal locked ingest of
// its own — prechecks may fetch a key, network never under a lock),
// oldest added_ms first; an accepted one queues the same lookup for ITS
// waiters (its own tail fires). Re-send re-checks too (precheck 5).
const recheckRunning = new Map<string, boolean>();

async function readStoredPdu(
  roomId: string,
  commitHash: string,
  eventId: string,
): Promise<Pdu | null> {
  const room = await lookupRoom(roomId);
  if (!room) return null;
  return await withDb(room.dbName, async (c) => {
    assertHash(commitHash);
    const r = await c.query(
      `SELECT canonical_json FROM events AS OF '${commitHash}' WHERE event_id = $1;`,
      [eventId],
    ).catch(() => ({ rows: [] }));
    if (r.rows.length === 0) return null;
    return (typeof r.rows[0].canonical_json === 'string'
      ? JSON.parse(String(r.rows[0].canonical_json))
      : r.rows[0].canonical_json) as Pdu;
  }).catch(() => null);
}

async function queuePlaceholderRechecks(roomId: string): Promise<void> {
  if (recheckRunning.get(roomId) === true) return;
  recheckRunning.set(roomId, true);
  try {
    for (;;) {
      const job = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          `SELECT w.event_id, w.missing_prev, i.rejected_reason, i.origin, i.commit_hash, i.added_ms
           FROM event_index_waiting w
           JOIN event_index i ON i.room_id = w.room_id AND i.event_id = w.event_id
           WHERE w.room_id = $1
           ORDER BY i.added_ms LIMIT 1;`,
          [roomId],
        );
        if (r.rows.length === 0) return null;
        const o = r.rows[0] as Record<string, unknown>;
        return {
          eventId: String(o.event_id),
          missingPrev: String(o.missing_prev),
          rejectedReason: o.rejected_reason == null
            ? null
            : String(o.rejected_reason),
          origin: o.origin == null ? '' : String(o.origin),
          commitHash: String(o.commit_hash),
        };
      });
      if (job === null) return;
      await recheckOne(roomId, job);
    }
  } finally {
    recheckRunning.delete(roomId);
  }
}

async function recheckOne(
  roomId: string,
  job: {
    eventId: string;
    missingPrev: string;
    rejectedReason: string | null;
    origin: string;
    commitHash: string;
  },
): Promise<void> {
  // a waiting REDACTION of an unknown target (§3.3): accepted and stored
  // when it arrived; its effect lands when the target arrives
  if (job.rejectedReason === null) {
    const pdu = await readStoredPdu(roomId, job.commitHash, job.eventId);
    if (pdu?.type === 'm.room.redaction') {
      await withDb(serverDb(), async (c) => {
        await c.query(
          'UPDATE event_index SET redacted_by = $1 WHERE event_id = $2;',
          [job.eventId, job.missingPrev],
        );
      });
    }
    await withDb(serverDb(), async (c) => {
      await c.query(
        'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
        [roomId, job.eventId],
      );
    });
    return;
  }
  if (job.rejectedReason !== 'ungrounded') {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
        [roomId, job.eventId],
      );
    });
    return;
  }
  // a placeholder: re-ingest (its deterministic branch is deleted before
  // the re-ingest creates it again — precheck 5's fall-through)
  const pdu = await readStoredPdu(roomId, job.commitHash, job.eventId);
  if (pdu === null) {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
        [roomId, job.eventId],
      );
    });
    return;
  }
  try {
    await ingestEvent(roomId, pdu, {
      remote: { origin: job.origin, position: 'after' },
    });
  } catch (e) {
    if (String(e).includes('M_UNKNOWN_PREV')) {
      // still ungrounded — refresh the waiting set to what is missing NOW
      const still: string[] = [];
      await withDb(serverDb(), async (c) => {
        const r = await c.query(
          'SELECT event_id FROM event_index WHERE room_id = $1 AND event_id = ANY($2);',
          [roomId, pdu.prev_events ?? []],
        );
        const known = new Set(
          // deno-lint-ignore no-explicit-any
          r.rows.map((row: any) => String(row.event_id)),
        );
        for (const pid of pdu.prev_events ?? []) {
          if (!known.has(pid)) still.push(pid);
        }
      });
      await withDb(serverDb(), async (c) => {
        await c.query(
          'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
          [roomId, job.eventId],
        );
        for (const pid of still) {
          await c.query(
            'INSERT INTO event_index_waiting (room_id, missing_prev, event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
            [roomId, pid, job.eventId],
          );
        }
      });
    } else {
      console.error(`federation: re-check of ${job.eventId} failed:`, e);
    }
  }
}

// ruling B expiry: lapsed placeholders leave — row, branch, waiting
// rows — so a later delivery is a first delivery. Runs on the room's
// next write (ingestEventLocked) and at startup; logged, not alerted.
export async function sweepExpiredPlaceholders(
  roomId?: string,
): Promise<number> {
  const now = Date.now();
  const lapsed = await withDb(serverDb(), async (c) => {
    const r = roomId === undefined
      ? await c.query(
        `SELECT event_id, room_id, branch_name FROM event_index
         WHERE rejected_reason = 'ungrounded' AND expires_ms IS NOT NULL AND expires_ms <= $1;`,
        [now],
      )
      : await c.query(
        `SELECT event_id, room_id, branch_name FROM event_index
         WHERE rejected_reason = 'ungrounded' AND expires_ms IS NOT NULL AND expires_ms <= $1 AND room_id = $2;`,
        [now, roomId],
      );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      eventId: String(row.event_id),
      roomId: String(row.room_id),
      branchName: row.branch_name == null ? null : String(row.branch_name),
    }));
  });
  for (const row of lapsed) {
    const dbName = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT db_name FROM room_directory WHERE room_id = $1;',
        [row.roomId],
      );
      return r.rows.length === 0 ? null : String(r.rows[0].db_name);
    });
    if (dbName !== null && row.branchName !== null) {
      const branch = row.branchName;
      await withDb(dbName, async (c) => {
        await c.query(`SELECT DOLT_BRANCH('-D', '${ident(branch)}');`)
          .catch(() => {});
      });
    }
    await withDb(serverDb(), async (c) => {
      await c.query(
        'DELETE FROM event_index WHERE room_id = $1 AND event_id = $2;',
        [row.roomId, row.eventId],
      );
      await c.query(
        'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
        [row.roomId, row.eventId],
      );
    });
    console.warn(
      `federation: expired ungrounded placeholder ${row.eventId} in ${row.roomId}`,
    );
  }
  return lapsed.length;
}

// M5b (§3.2): one outbox row per destination — domains of members
// JOINED in the state BEFORE the event (SS's ban reasoning; Synapse
// sender/__init__.py:654-664) ∪ the target's domain for an m.room.member
// leave/ban with a remote state_key (the leaving/kicked/banned server
// must hear it even if it has no member left in the state before) −
// ourselves − the on-behalf origin (the resident fans its own joiner
// out; invites are not in the union — the invitee's server is told
// through /invite, §3.8).
function deliveryDestinations(
  resolved: StateMap,
  pduById: Map<string, Pdu>,
  pdu: Pdu,
  onBehalfOrigin: string | null,
): string[] {
  const domains = new Set<string>();
  for (const [k, eid] of resolved) {
    if (!k.startsWith('m.room.member')) continue;
    const ep = pduById.get(eid);
    if (!ep) continue;
    if (
      ((ep.content ?? {}) as { membership?: string }).membership !== 'join'
    ) {
      continue;
    }
    const sk = k.slice('m.room.member'.length + 1);
    const at = sk.indexOf(':');
    if (at >= 0) domains.add(sk.slice(at + 1));
  }
  if (pdu.type === 'm.room.member' && pdu.state_key != null) {
    const ms = ((pdu.content ?? {}) as { membership?: string }).membership;
    if (ms === 'leave' || ms === 'ban') {
      const at = String(pdu.state_key).indexOf(':');
      if (at >= 0) domains.add(String(pdu.state_key).slice(at + 1));
    }
  }
  domains.delete(serverName());
  if (onBehalfOrigin !== null) domains.delete(onBehalfOrigin);
  return [...domains];
}

// E2 fold — the PUBLISHED current-state rows' m.room.member entries into
// the per-user membership index (a derived cache of the chapter, same
// writer step as the publish). M5b (r4-c): the fold KEEPS an existing
// row's seq when its event_id is unchanged, and stamps a row only when
// the membership event changes — with the member event's own seq when it
// has one, the triggering event's otherwise (a plain COALESCE would
// re-stamp every NULL-seq snapshot member on every later publish, and
// re-stamping every row would replay every old leaver in every
// incremental sync). The old-vs-new event_id comparison is done in JS:
// Doltgres's ON CONFLICT applies the SET clauses before evaluating a
// CASE on the table's columns, so an inline CASE always sees the NEW
// value (probe, 2026-09-27).
async function foldMembership(
  roomId: string,
  publishedRows: StateRowInput[],
  pdu: Pdu,
  triggeringSeq: number | null,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    for (const r of publishedRows) {
      if (r.type !== 'm.room.member') continue;
      // D4: a membership event FOR THE USER clears the forgotten flag
      // (a re-join after /forget makes the room visible again) — that is
      // THIS event's own state_key. The full-state fold below keeps the
      // index fresh for everyone else WITHOUT touching the flag:
      // resetting there would un-forget the room on any later event.
      const clearsForget = pdu.type === 'm.room.member' &&
        r.stateKey === String(pdu.state_key ?? '');
      const own = await c.query(
        'SELECT seq FROM event_index WHERE event_id = $1;',
        [r.eventId],
      );
      const ownSeq = own.rows.length > 0 && own.rows[0].seq != null
        ? Number(own.rows[0].seq)
        : null;
      const existing = await c.query(
        'SELECT event_id, seq FROM room_membership WHERE room_id = $1 AND user_id = $2;',
        [roomId, r.stateKey],
      );
      const keep = existing.rows.length > 0 &&
        String(existing.rows[0].event_id) === r.eventId;
      const seq = keep
        ? Number(existing.rows[0].seq)
        : (ownSeq ?? triggeringSeq);
      await c.query(
        `INSERT INTO room_membership (room_id, user_id, membership, event_id, seq)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (room_id, user_id) DO UPDATE SET membership=EXCLUDED.membership, event_id=EXCLUDED.event_id, seq=EXCLUDED.seq${
          clearsForget ? ', forgotten=FALSE' : ''
        };`,
        [
          roomId,
          r.stateKey,
          (r.content as { membership?: string }).membership ?? 'leave',
          r.eventId,
          seq,
        ],
      );
    }
  });
}
// Steps 6-12 of ingest, inside the per-room lock (E5). M5b: exported for
// the federation/ package — callers MUST hold the room lock
// (withRoomLock); network I/O never runs under it.
export async function ingestEventLocked(
  roomId: string,
  pdu: Pdu,
  opts: IngestOptions,
  pre: IngestPrecheck,
): Promise<IngestResult> {
  const { room, eventId, hashOk, sigOk, oversized, redeliverUngrounded } = pre;
  const rulebook = getRulebook(room.roomVersion);
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];
  const position = opts.remote?.position ?? 'after';
  // The chapter this event belongs to (M5b): live events carry the
  // room's CURRENT chapter; 'before'/'evidence' rows are positioned by
  // their callers (commits 8/10) and never enter the live stream.
  const currentChapter = room.currentChapter;
  // §3.4 (fix pass): a leave/reject by a LOCAL user whose membership is
  // invite or knock may land on a CLOSED stay (the last joined local
  // member left) — it does not reopen (current_chapter stays NULL); the
  // event's era, its prevs' consumption, and the publish branch are the
  // newest stay's
  const archivedReject = currentChapter === null &&
    pdu.type === 'm.room.member' &&
    ((pdu.content ?? {}) as { membership?: unknown }).membership ===
      'leave' &&
    String(pdu.state_key ?? '').endsWith(':' + serverName()) &&
    ['invite', 'knock'].includes(
      (await membershipOf(roomId, String(pdu.state_key)))?.membership ?? '',
    );
  const eraChapter = archivedReject
    ? await chapterHead(roomId)
    : currentChapter;

  // ruling B expiry: lapsed placeholders leave on the room's next write
  if (opts.remote) {
    await sweepExpiredPlaceholders(roomId);
  }

  // 6. prev resolution via the server DB's event_index (D8: the extremity
  //    branch comes from event_index.branch_name, not recomputation).
  const prevs = await resolvePrevs(roomId, prevIds);

  // 7. depth check (genesis = 1: spec positive, empty prevs => 1). M5b:
  //    computed only for LOCAL events — remote events passed the bound in
  //    precheck 2 (components/depth_v6.yaml:19-25 is the only MUST on
  //    depth; pdu_v3.yaml:28-34 describes what a *sender* puts there and
  //    no room version's auth rules check it).
  const depths = await prevDepths(room.dbName, prevs);
  const computedDepth = prevs.length === 0 ? 1 : Math.max(...depths) + 1;
  const depthOk = opts.remote ? true : pdu.depth === computedDepth;

  // 8. parent states + the M3 EventStore over the full ancestry (contents,
  //    rejected flags — S8 check 4 needs the event's own auth events). The
  //    store must also cover the OTHER branches: the soft-fail check
  //    resolves the current state across all extremities, whose lineage
  //    may hold events absent from this event's parent lineage.
  const parentSets: StateMap[] = [];
  for (const p of prevs) {
    parentSets.push(await parentStateAt(room.dbName, p.commitHash));
  }
  const xbs = await extremities(room.dbName, roomId, eraChapter ?? undefined);
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
  let rejectRule: string | null = null;
  if (oversized) {
    // M5b: a lenient-version per-key size failure — stored rejected
    // 'oversized' (Synapse federation_event.py:1852-1868).
    verdict = 'state-reject';
  } else if (!hashOk || !sigOk || !depthOk) {
    verdict = 'authchain-reject';
  } else {
    const chain = rulebook.checkAuthChain(pdu, store);
    // M5b: for REMOTE events the declared auth_events are checked by
    // rules 1–2 only — spec rule 2 *is* the "right (type, state_key)
    // set" check D1 asked for, so "compare as a set, never reject for a
    // mismatch with our own selection" and "rules 1–2 only" are the same
    // outcome. selectAuthEvents is still computed for local authoring.
    const selected = opts.remote
      ? null
      : rulebook.selectAuthEvents(pdu, resolved);
    if (
      !chain.ok ||
      (!isCreate && selected !== null &&
        !sameIdSet([...declaredAuth], selected))
    ) {
      verdict = 'authchain-reject';
      if (!chain.ok) rejectRule = chain.rule;
    } else {
      const state = rulebook.checkAuthAgainstState(pdu, resolved, store);
      if (!state.ok) {
        verdict = 'state-reject';
        rejectRule = state.rule;
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
  // M5b: the machine standing beside the rejected flag. 'unverifiable'
  // (snapshot/history events whose signature or hash failed but that are
  // referenced) and 'ungrounded' are written by their own paths (commits
  // 4/5/8); the relaxed remote checks can only land 'auth'/'state' here.
  const rejectedReason: string | null = oversized
    ? 'oversized'
    : verdict === 'authchain-reject'
    ? 'auth'
    : verdict === 'state-reject'
    ? 'state'
    : null;

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

    // M5b (D1): branch from the prev's COMMIT HASH, not its live branch —
    // a late fork is a branch from an older commit (P1: DOLT_BRANCH takes
    // a hash; the branch-membership check and E_BRANCH_POINTER_DRIFT are
    // gone). A zero-prev event (the create) starts from the current
    // chapter, which sits at the genesis commit.
    const newBranch = await branchNameFor(eventId);
    if (redeliverUngrounded) {
      // ruling B: the placeholder's deterministic branch is deleted
      // before the re-ingest creates it again from the real prev.
      const branchRows = await c.query('SELECT name FROM dolt.branches;');
      const names = new Set(
        branchRows.rows.map((r: { name: string }) => String(r.name)),
      );
      if (names.has(newBranch)) {
        await c.query(`SELECT DOLT_BRANCH('-D', '${ident(newBranch)}');`);
      }
    }
    if (prevs.length === 0) {
      if (currentChapter === null) {
        throw new Error(
          'E_ROOM_ARCHIVED: zero-prev ingest on an archived room',
        );
      }
      await c.query(`SELECT DOLT_CHECKOUT('${ident(currentChapter)}');`);
      await c.query(`SELECT DOLT_CHECKOUT('-b', '${ident(newBranch)}');`);
    } else {
      assertHash(prevs[0].commitHash);
      await c.query(
        `SELECT DOLT_BRANCH('${ident(newBranch)}', '${prevs[0].commitHash}');`,
      );
      await c.query(`SELECT DOLT_CHECKOUT('${ident(newBranch)}');`);
    }
    // N-way fan-in chains 2-parent commits on the new branch (Dolt holds
    // one active merge at a time — each merge but the last is committed
    // as bookkeeping; only the final commit carries the event and is
    // indexed). The event DAG keeps all N in prev_events, and resolution
    // already ran over the full parent set. M5b: the fan-in merges the
    // other prevs' COMMIT HASHES (P1-m — mergeDriver takes any ref).
    const fanin = prevs.slice(1);
    for (let i = 0; i < fanin.length; i++) {
      assertHash(fanin[i].commitHash);
      await mergeDriver(c, fanin[i].commitHash);
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
    // ancestors (dangling-extremity handling). M5b: consumption runs only
    // for prevs whose branch still exists AND belongs to the current
    // chapter — a prev already consumed has none to delete, and an
    // old-era prev's branch is the archive's, never ours to take (§3.6a).
    if (!rejected && !softFailed && !opts.keepPrevBranches) {
      const liveRows = await c.query('SELECT name FROM dolt.branches;');
      const live = new Set(
        liveRows.rows.map((r: { name: string }) => String(r.name)),
      );
      for (const p of prevs) {
        if (p.branch === null || !live.has(p.branch)) continue;
        if (p.era !== eraChapter) continue;
        await consumeBranchChain(c, roomId, p, eraChapter ?? '');
      }
    }
    return { commitHash, newBranch };
  });

  // event_id <-> commit_hash bijection + current branch (D8), flagged
  // rejected/soft-failed as the S8 checks decided (prev resolution needs
  // the id; rejected/soft-failed events still persist verbatim). M5b:
  // the row also carries the standing reason, the delivering server, the
  // write time, and the event's POSITION — 'after' (live) takes the
  // stream's next seq and the current chapter as its era; 'before' /
  // 'evidence' are seq NULL (never news) with their branch fields set by
  // their own paths (commits 8/10). A redelivered 'ungrounded'
  // placeholder is UPDATED in place (ruling B).
  const isLive = position === 'after';
  // M5b (§3.2, D2): the outbox rows ride the SAME server-DB transaction
  // as the index row (P2) — a crash cannot store the event and forget
  // the obligation. One row per destination when the event is accepted
  // and ours to deliver (authored here, or on another server's behalf).
  const deliverTo = isLive && !rejected && !softFailed &&
      (opts.remote === undefined || opts.remote.onBehalfOf === true)
    ? deliveryDestinations(
      resolved,
      ancestry.pduById,
      pdu,
      opts.remote?.origin ?? null,
    )
    : [];
  const eventSeq = await withDb(serverDb(), async (c) => {
    await c.query('BEGIN;');
    try {
      if (redeliverUngrounded) {
        await c.query(
          `UPDATE event_index SET commit_hash = $3, branch_name = $4, rejected = $5, soft_failed = $6,
           rejected_reason = $7, origin = $8, expires_ms = NULL, added_ms = $9,
           era = $10, seq = DEFAULT, state_commit_hash = NULL
         WHERE event_id = $1 AND room_id = $2;`,
          [
            eventId,
            roomId,
            commitHash,
            isLive ? newBranch : null,
            rejected,
            softFailed,
            rejectedReason,
            opts.remote?.origin ?? null,
            Date.now(),
            isLive ? eraChapter : null,
          ],
        );
        // grounded now (or re-flagged) — the waiting rows are spent
        await c.query(
          'DELETE FROM event_index_waiting WHERE room_id = $1 AND event_id = $2;',
          [roomId, eventId],
        );
      } else {
        await c.query(
          `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed, txn_device, txn_id,
           rejected_reason, origin, added_ms, era${isLive ? '' : ', seq'})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12${
            isLive ? '' : ', NULL'
          });`,
          [
            eventId,
            roomId,
            commitHash,
            isLive ? newBranch : null,
            rejected,
            softFailed,
            opts.txn?.deviceId ?? null,
            opts.txn?.txnId ?? null,
            rejectedReason,
            opts.remote?.origin ?? null,
            Date.now(),
            isLive ? eraChapter : null,
          ],
        );
      }
      if (deliverTo.length > 0) {
        await writeOutboxRows(
          c,
          deliverTo.map((destination) => ({
            destination,
            roomId,
            kind: 'event' as const,
            eventId,
          })),
        );
      }
      await c.query('COMMIT;');
    } catch (e) {
      await c.query('ROLLBACK;');
      throw e;
    }
    const sq = await c.query(
      'SELECT seq FROM event_index WHERE event_id = $1;',
      [eventId],
    );
    return sq.rows[0].seq == null ? null : Number(sq.rows[0].seq);
  });
  // M5b: the derived writes (relations, search_index, room_membership)
  // run only for POSITIONED events (seq IS NOT NULL) — history rows are
  // readable through the chapter walk but are not indexed for /relations
  // or /search in M5b (§8).
  if (eventSeq !== null) {
    await withDb(serverDb(), async (c) => {
      // D7: the relations index — content['m.relates_to'] with a direct
      // event_id (rich replies carry theirs under m.in_reply_to instead and
      // are NOT relations rows). seq is the event's own event_index seq, so
      // /relations pages on the sync-token grammar (§3e).
      const relatesTo = (pdu.content ?? {})['m.relates_to'];
      if (
        relatesTo !== null && typeof relatesTo === 'object' &&
        typeof (relatesTo as Record<string, unknown>).event_id === 'string'
      ) {
        const rt = relatesTo as Record<string, unknown>;
        await c.query(
          `INSERT INTO relations (event_id, relates_to, rel_type, room_id, seq)
         VALUES ($1, $2, $3, $4, (SELECT seq FROM event_index WHERE event_id = $1));`,
          [
            eventId,
            rt.event_id,
            typeof rt.rel_type === 'string' ? rt.rel_type : null,
            roomId,
          ],
        );
      }
      // Search index (D1): accepted (not rejected, not soft-failed)
      // message/name/topic events. seq is the event's own event_index seq.
      if (!rejected && !softFailed) {
        const indexed = searchTextOf(pdu);
        if (indexed !== null) {
          await c.query(
            `INSERT INTO search_index (event_id, room_id, seq, key, sender, origin_ts, body_lower)
           VALUES ($1, $2, (SELECT seq FROM event_index WHERE event_id = $1), $3, $4, $5, $6);`,
            [
              eventId,
              roomId,
              indexed.key,
              pdu.sender,
              pdu.origin_server_ts,
              indexed.text,
            ],
          );
        }
      }
    });
  }

  // 12. republish the room's current state on the CURRENT CHAPTER (M5b —
  //     main is the system branch and never holds content): resolve
  //     across the post-event extremity set (extremities() reads the
  //     flags just written and filters to the current chapter's era, so a
  //     rejected/soft-failed event is excluded and consumed prevs are
  //     gone). The store already covers every pre-existing extremity's
  //     ancestry (step 8) plus this pdu. Live events only — 'before' /
  //     'evidence' rows never move the live chapter.
  let stateHash: string | null = null;
  let publishedRows: StateRowInput[] = [];
  let current: StateMap = new Map();
  if (isLive) {
    if (eraChapter === null) {
      throw new Error('E_ROOM_ARCHIVED: publish on an archived room');
    }
    const after = await extremities(room.dbName, roomId, eraChapter);
    const afterSets: StateMap[] = [];
    for (const xb of after) {
      const h = await commitHashOf(roomId, xb.eventId);
      if (h) afterSets.push(await parentStateAt(room.dbName, h));
    }
    current = rulebook.resolveState(afterSets, store);
    publishedRows = stateRowsOf(current, ancestry.pduById);
    stateHash = await publishCurrentState(
      room.dbName,
      eraChapter,
      publishedRows,
      `after ${eventId}`,
    );
  }

  // E1/E2 — state history: record the chapter's hash right after the
  // publish as this event's state pointer ("state at seq N" = state AS OF
  // the state_commit_hash of the last R-event with seq <= N), and fold
  // the PUBLISHED current-state rows' m.room.member entries into the
  // per-user membership index (a derived cache of the chapter, same
  // writer step).
  if (isLive && stateHash !== null) {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'UPDATE event_index SET state_commit_hash = $1 WHERE event_id = $2;',
        [stateHash, eventId],
      );
    });
  }
  if (isLive && stateHash !== null) {
    await foldMembership(roomId, publishedRows, pdu, eventSeq);
  }

  // M5b (§3.6a): the server's LAST LOCAL MEMBER leaving closes the stay —
  // after that leave's publish and its index rows are written (the leave
  // must still be deliverable; commit 3 adds its outbox rows). Closing is
  // clearing current_chapter — nothing is renamed or moved; the stay's
  // branch simply stops growing and its x* branches stay (they hold the
  // events' commits) but are inert under the era-filtered extremities().
  if (
    isLive && !rejected && !softFailed && pdu.type === 'm.room.member' &&
    ((pdu.content ?? {}).membership === 'leave' ||
      (pdu.content ?? {}).membership === 'ban') &&
    String(pdu.state_key ?? '').endsWith(':' + serverName())
  ) {
    if (!(await serversInRoom(roomId)).includes(serverName())) {
      await withDb(serverDb(), async (c) => {
        await c.query(
          'UPDATE room_directory SET current_chapter = NULL WHERE room_id = $1;',
          [roomId],
        );
      });
    }
  }

  // ruling B (§3.2/§3.3): an event that gains real grounding — accepted,
  // or stored rejected for 'auth'/'state' — wakes its waiters: queued
  // placeholder re-checks run after this lock releases, and an accepted
  // redaction whose target just arrived is applied. A redaction whose
  // target we STILL do not hold is itself stored with a waiting row (its
  // effect lands when the target arrives, via the same driver).
  if (!softFailed && pdu.type === 'm.room.redaction' && !rejected) {
    const target = typeof (pdu.content ?? {}).redacts === 'string'
      ? String((pdu.content ?? {}).redacts)
      : typeof pdu.redacts === 'string'
      ? pdu.redacts
      : null;
    if (target !== null) {
      await withDb(serverDb(), async (c) => {
        const held = await c.query(
          'SELECT 1 FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [roomId, target],
        );
        if (held.rows.length > 0) {
          await c.query(
            'UPDATE event_index SET redacted_by = $1 WHERE event_id = $2;',
            [eventId, target],
          );
        } else {
          await c.query(
            'INSERT INTO event_index_waiting (room_id, missing_prev, event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
            [roomId, target, eventId],
          );
        }
      });
    }
  }
  if (
    !softFailed &&
    (!rejected || rejectedReason === 'auth' || rejectedReason === 'state')
  ) {
    const hasWaiters = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT 1 FROM event_index_waiting WHERE room_id = $1 AND missing_prev = $2 LIMIT 1;',
        [roomId, eventId],
      );
      return r.rows.length > 0;
    });
    if (hasWaiters) void queuePlaceholderRechecks(roomId);
  }

  // D8: push-rule migration hooks, after publish — manual upgrades are
  // detected exactly the way a client performs them (tombstone in the old
  // room, predecessor on the new room's create), and a user joining a
  // room with a predecessor gets their own rules copied (the remote
  // case; harmless locally). Copy-if-absent everywhere, so the
  // /upgrade-path's own migrateRoomRules call and these hooks never
  // double-write. Live events only.
  if (isLive && !rejected && !softFailed) {
    if (pdu.type === 'm.room.tombstone') {
      const target = (pdu.content ?? {}).replacement_room;
      if (typeof target === 'string') {
        await migrateRoomRules(roomId, target);
      }
    }
    if (pdu.type === 'm.room.create') {
      const pred = (pdu.content ?? {}).predecessor as
        | Record<string, unknown>
        | undefined;
      if (typeof pred?.room_id === 'string') {
        await migrateRoomRules(pred.room_id, roomId);
      }
    }
    if (
      pdu.type === 'm.room.member' &&
      (pdu.content ?? {}).membership === 'join'
    ) {
      const joiner = String(pdu.state_key ?? '');
      if (joiner.startsWith('@') && joiner.endsWith(':' + serverName())) {
        const createId = current.get(stateKeyOf('m.room.create', ''));
        const createPdu = createId !== undefined
          ? ancestry.pduById.get(createId) ?? null
          : null;
        const pred = createPdu?.content?.predecessor as
          | Record<string, unknown>
          | undefined;
        if (typeof pred?.room_id === 'string') {
          // push_rules.localpart holds bare localparts — strip the MXID
          await migrateRoomRules(pred.room_id, roomId, localpartOf(joiner));
        }
      }
    }
  }

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
    throw new Error(
      'M_AUTHCHAIN_REJECT: ' + eventId +
        (rejectRule !== null ? ' (rule ' + rejectRule + ')' : ''),
    );
  }
  if (verdict === 'state-reject') {
    throw new Error(
      'M_STATE_REJECT: ' + eventId +
        (rejectRule !== null ? ' (rule ' + rejectRule + ')' : ''),
    );
  }
  return { event_id: eventId, commit_hash: commitHash };
}

// M5b (§3.6 steps 8–9, §3.6b): the join-snapshot path — a room's stay
// opens with the snapshot as its ROOT COMMIT and the join on top. The
// caller holds the room lock (withRoomLock — the lock is not reentrant)
// and has already: provisioned the room when absent, allocated the
// chapter pair (the history chapter empty at genesis; `chapter` = the
// new stay, created at genesis_commit), checked the snapshot (step 7),
// and authored/signed the join. This function: (ii) auths the join
// against the root commit's state (rules 3–10); (iii) branches x<join>
// from the root and commits the join there; (iv) sets current_chapter
// and writes the join's index row (live: fresh positive seq, era = the
// new stay) — the join is the stay's only extremity; (v) publishes the
// stay's first state commit onto the stay branch and records the state
// pointer + the membership fold. No outbox rows (the resident fans out —
// commit 3 wires deliveries for local events).
export async function ingestJoinSnapshotLocked(
  roomId: string,
  args: {
    // the new stay branch, already created at genesis_commit
    chapter: string;
    // snapshot/auth-chain events for the root commit — `rejected` rides
    // for events that failed the snapshot's own auth check (§3.6 step 7:
    // stored with 'auth')
    rootEvents: { pdu: Pdu; eventId: string; rejected?: boolean }[];
    // the snapshot's materialized state (state AFTER the snapshot)
    rootStateRows: StateRowInput[];
    // the signed join (event_id computed)
    join: Pdu;
    rootMessage: string;
    // the resident server; NULL for the local reopen (§3.6b)
    origin: string | null;
    // true → write 'evidence' index rows for rootEvents (a remote
    // snapshot's NEW events, commit 8); false = already held (the local
    // reopen — their rows and positions stay untouched)
    newEvidence: boolean;
  },
): Promise<IngestResult> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
  const joinId = String(args.join.event_id);

  // (ii) auth of the join against the root commit's state (rules 3–10)
  const rootState: StateMap = new Map();
  for (const r of args.rootStateRows) {
    rootState.set(stateKeyOf(r.type, r.stateKey), r.eventId);
  }
  const pduById = new Map<string, Pdu>();
  for (const e of args.rootEvents) pduById.set(e.eventId, e.pdu);
  pduById.set(joinId, args.join);
  const store = eventStoreOf(pduById, new Set());
  const auth = rulebook.checkAuthAgainstState(args.join, rootState, store);
  if (!auth.ok) {
    throw new Error(
      'M_STATE_REJECT: ' + joinId + ' (rule ' + (auth.rule ?? '?') + ')',
    );
  }

  const { rootHash, joinCommit, xBranch } = await withDb(
    room.dbName,
    async (c) => {
      await c.query('SET dolt_allow_commit_conflicts = 1;');
      // the root commit on the new stay branch
      await c.query(`SELECT DOLT_CHECKOUT('${ident(args.chapter)}');`);
      for (const e of args.rootEvents) {
        await c.query(
          'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
          [
            e.eventId,
            e.pdu.type,
            e.pdu.state_key ?? null,
            e.pdu.sender,
            e.pdu.origin_server_ts,
            e.pdu.depth,
            JSON.stringify(e.pdu.prev_events ?? []),
            JSON.stringify(e.pdu.auth_events ?? []),
            JSON.stringify(e.pdu.hashes ?? {}),
            JSON.stringify(e.pdu.signatures ?? {}),
            e.rejected === true,
            false,
            canonicalJson(e.pdu as unknown as Record<string, unknown>),
          ],
        );
      }
      await materialize(c, args.rootStateRows);
      await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [args.rootMessage]);
      const rh = await c.query(`SELECT HASHOF('HEAD');`);
      const rootHash = String(Object.values(rh.rows[0])[0]);

      // (iii) the join on its own x* branch from the root
      const xBranch = await branchNameFor(joinId);
      await c.query(`SELECT DOLT_BRANCH('${ident(xBranch)}', '${rootHash}');`);
      await c.query(`SELECT DOLT_CHECKOUT('${ident(xBranch)}');`);
      await c.query(
        'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);',
        [
          joinId,
          args.join.type,
          args.join.state_key ?? null,
          args.join.sender,
          args.join.origin_server_ts,
          args.join.depth,
          JSON.stringify(args.join.prev_events ?? []),
          JSON.stringify(args.join.auth_events ?? []),
          JSON.stringify(args.join.hashes ?? {}),
          JSON.stringify(args.join.signatures ?? {}),
          false,
          false,
          canonicalJson(args.join as unknown as Record<string, unknown>),
        ],
      );
      // the x* commit's state = the root state with the join applied
      const afterRows = args.rootStateRows.filter((r) =>
        !(r.type === String(args.join.type) &&
          r.stateKey === String(args.join.state_key ?? ''))
      );
      if (args.join.state_key != null) {
        afterRows.push({
          type: String(args.join.type),
          stateKey: String(args.join.state_key),
          eventId: joinId,
          content: args.join.content ?? {},
        });
      }
      await materialize(c, afterRows);
      const res = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
        `event ${joinId} type ${String(args.join.type)}`,
      ]);
      let joinCommit = res.rows[0]
        ? String(Object.values(res.rows[0])[0] ?? '')
        : '';
      if (joinCommit === '') {
        const h = await c.query(`SELECT HASHOF('HEAD');`);
        joinCommit = String(Object.values(h.rows[0])[0]);
      }
      return { rootHash, joinCommit, xBranch };
    },
  );

  // (iv) current_chapter + the join's index row (live: fresh positive
  // seq, era = the new stay) — and, for a remote snapshot, the
  // 'evidence' rows of the snapshot's new events (seq NULL, no branch,
  // commit_hash = the root).
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE room_directory SET current_chapter = $2 WHERE room_id = $1;',
      [roomId, args.chapter],
    );
    await c.query(
      `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
         rejected_reason, origin, added_ms, era)
       VALUES ($1, $2, $3, $4, FALSE, FALSE, NULL, $5, $6, $7);`,
      [
        joinId,
        roomId,
        joinCommit,
        xBranch,
        args.origin,
        Date.now(),
        args.chapter,
      ],
    );
    if (args.newEvidence) {
      for (const e of args.rootEvents) {
        await c.query(
          `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
             rejected_reason, origin, added_ms, era, seq)
           VALUES ($1, $2, $3, NULL, $4, FALSE, $5, $6, $7, NULL, NULL)
           ON CONFLICT (event_id) DO NOTHING;`,
          [
            e.eventId,
            roomId,
            rootHash,
            e.rejected === true,
            e.rejected === true ? 'auth' : null,
            args.origin,
            Date.now(),
          ],
        );
      }
    }
  });
  const joinSeq = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT seq FROM event_index WHERE event_id = $1;',
      [joinId],
    );
    return r.rows[0].seq == null ? null : Number(r.rows[0].seq);
  });

  // (v) publish the stay's first state commit ONTO the stay branch (the
  // join is the stay's only extremity) + the state pointer + the fold.
  const afterSets: StateMap[] = [rootState];
  for (const [k, eid] of rootState) void k, void eid;
  const published = rulebook.resolveState(afterSets, store);
  const publishedRows = stateRowsOf(published, pduById);
  if (args.join.state_key != null) {
    const at = publishedRows.findIndex((r) =>
      r.type === String(args.join.type) &&
      r.stateKey === String(args.join.state_key)
    );
    const row: StateRowInput = {
      type: String(args.join.type),
      stateKey: String(args.join.state_key),
      eventId: joinId,
      content: args.join.content ?? {},
    };
    if (at >= 0) publishedRows[at] = row;
    else publishedRows.push(row);
  }
  const stateHash = await publishCurrentState(
    room.dbName,
    args.chapter,
    publishedRows,
    `after ${joinId}`,
  );
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE event_index SET state_commit_hash = $1 WHERE event_id = $2;',
      [stateHash, joinId],
    );
  });
  await foldMembership(roomId, publishedRows, args.join, joinSeq);

  for (const l of appliedListeners) {
    try {
      l(roomId, joinId);
    } catch (e) {
      console.error('applied listener error:', e);
    }
  }
  return { event_id: joinId, commit_hash: joinCommit };
}
