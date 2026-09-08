import { branchNameFor, ident, SERVER_DB, withDb } from './db.ts';
import { extremities, lookupRoom } from './room.ts';
import { mergeDriver } from './mergedriver.ts';
import { eventIdFor } from './eventid.ts';
import { canonicalJson } from './canonical.ts';
import { signPdu, verifyPduSignature } from './signing.ts';
import { getTenantKey } from './tenant.ts';
import { materialize, type StateRowInput } from './materialize.ts';
import {
  getRulebook,
  stateKeyOf,
  type AuthContext,
  type StateMap,
} from './policy.ts';
import type { Pdu } from './pdu.ts';
import { contentHashOf, importPublicKeyFromRaw, isKeyName, b32decode } from '../../lite/web/sync/signing.js';

export interface IngestResult {
  event_id: string;
  commit_hash: string;
}

export interface IngestOptions {
  // TEST HOOK ONLY (phase-2 fork test): skip deleting consumed prev
  // branches in step 8 so a second event can reference the same prev.
  keepPrevBranches?: boolean;
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

// Fetch PDUs for ids, trying each commit hash in order (events rows are
// immutable; any hash whose history contains the event will serve).
async function fetchPdus(
  dbName: string,
  hashes: string[],
  ids: string[],
): Promise<Map<string, Pdu>> {
  const out = new Map<string, Pdu>();
  if (ids.length === 0) return out;
  await withDb(dbName, async (c) => {
    const missing = new Set(ids);
    for (const h of hashes) {
      if (missing.size === 0) break;
      assertHash(h);
      const r = await c.query(
        `SELECT event_id, canonical_json FROM events AS OF '${h}' WHERE event_id = ANY($1);`,
        [[...missing]],
      );
      // deno-lint-ignore no-explicit-any
      for (const row of r.rows as any[]) {
        out.set(String(row.event_id), parseStoredPdu(row.canonical_json));
        missing.delete(String(row.event_id));
      }
    }
  });
  return out;
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
  dbName: string,
  prevIds: string[],
): Promise<{ id: string; commitHash: string; branch: string | null }[]> {
  const prevs: { id: string; commitHash: string; branch: string | null }[] = [];
  await withDb(SERVER_DB, async (c) => {
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
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
  const prevIds = partial.prev_events ??
    (await extremities(room.dbName, roomId)).map((e) => e.eventId);
  if (prevIds.length > 20) {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  const isCreate = partial.type === 'm.room.create' && prevIds.length === 0;
  const prevs = await resolvePrevs(roomId, room.dbName, prevIds);
  const depths = await prevDepths(room.dbName, prevs);
  const depth = prevs.length === 0 ? 1 : Math.max(...depths) + 1;

  const parentSets: StateMap[] = [];
  for (const p of prevs) {
    parentSets.push(await parentStateAt(room.dbName, p.commitHash));
  }
  // Resolution first: authoring a heal over conflicted parents is refused
  // here, not guessed (the stub throws M_UNRESOLVED_CONFLICT).
  const resolved = rulebook.resolveState(parentSets);
  const hashes = prevs.map((p) => p.commitHash);
  const wanted = new Set<string>(prevIds);
  for (const s of parentSets) for (const id of s.values()) wanted.add(id);
  const pduById = await fetchPdus(room.dbName, hashes, [...wanted]);

  let createEventId: string;
  if (isCreate) {
    createEventId = '';
  } else {
    const found = parentSets.length > 0
      ? parentSets[0].get(stateKeyOf('m.room.create', ''))
      : undefined;
    if (!found) throw new Error('M_NO_CREATE: parent state has no create');
    createEventId = found;
  }
  const ctx: AuthContext = {
    stateAtPrevs: resolved,
    getEvent: (id) => pduById.get(id),
    createEventId,
  };
  const pdu: Pdu = {
    type: partial.type,
    room_id: roomId,
    sender: partial.sender,
    content: (partial.content ?? {}) as Record<string, unknown>,
    prev_events: [...prevIds],
    auth_events: isCreate
      ? []
      : rulebook.selectAuthEvents(
        {
          type: partial.type,
          sender: partial.sender,
          state_key: partial.state_key,
          content: (partial.content ?? {}) as Record<string, unknown>,
        } as Pdu,
        ctx,
      ),
    depth,
    origin_server_ts: partial.origin_server_ts ?? Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
  const key = await getTenantKey();
  await signPdu(pdu, room.roomVersion, key);
  if (isCreate) {
    // self-reference resolved post-id (create carries no auth_events).
    void createEventId;
  }
  return pdu;
}

export async function ingestEvent(
  roomId: string,
  pdu: Pdu,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  // 1. room + version gate (unknown -> never a default).
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const rulebook = getRulebook(room.roomVersion);
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
    expect = await eventIdFor(pdu as unknown as Record<string, unknown>, room.roomVersion);
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
  const existing = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE event_id = $1;',
      [eventId],
    );
    return r.rows.length ? String(r.rows[0].commit_hash) : null;
  });
  if (existing) return { event_id: eventId, commit_hash: existing };

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
  // deleted — every engine signs). Entries under our own SERVER_NAME
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

  // 6. prev resolution via the server DB's event_index (D8: the extremity
  //    branch comes from event_index.branch_name, not recomputation).
  const prevs = await resolvePrevs(roomId, room.dbName, prevIds);

  // 7. depth check (genesis = 1: spec positive, empty prevs => 1).
  const depths = await prevDepths(room.dbName, prevs);
  const computedDepth = prevs.length === 0 ? 1 : Math.max(...depths) + 1;
  const depthOk = pdu.depth === computedDepth;

  // 8. parent states + validation context.
  const parentSets: StateMap[] = [];
  for (const p of prevs) {
    parentSets.push(await parentStateAt(room.dbName, p.commitHash));
  }
  const hashes = prevs.map((p) => p.commitHash);
  const wanted = new Set<string>(prevIds);
  for (const s of parentSets) for (const id of s.values()) wanted.add(id);
  const pduById = await fetchPdus(room.dbName, hashes, [...wanted]);
  pduById.set(eventId, pdu);
  const isCreate = pdu.type === 'm.room.create' && prevIds.length === 0;
  const createEventId = isCreate
    ? eventId
    : parentSets[0]?.get(stateKeyOf('m.room.create', ''));
  if (!createEventId) throw new Error('M_NO_CREATE: no create in ancestry');

  const ctx: AuthContext = {
    stateAtPrevs: new Map<string, string>(),
    getEvent: (id) => pduById.get(id),
    createEventId,
  };

  // 9. resolve parents (throws M_UNRESOLVED_CONFLICT — the room stays
  // forked; the heal is stored below as rejected and the error surfaces).
  let resolved: StateMap;
  let conflicted = false;
  try {
    resolved = rulebook.resolveState(parentSets);
  } catch (e) {
    if (!String(e).includes('M_UNRESOLVED_CONFLICT')) throw e;
    conflicted = true;
    resolved = parentSets.length > 0 ? new Map(parentSets[0]) : new Map();
  }
  ctx.stateAtPrevs = resolved;

  // 10. auth: declared auth_events must equal the shared selection
  // (spec check 2.2), then the rulebook's verdict. No timestamp is
  // consulted; the stub checks membership only (no power levels — M3).
  let verdict: 'ok' | 'authchain-reject' | 'state-reject' | 'soft-fail' = 'ok';
  if (!hashOk || !sigOk || !depthOk) {
    verdict = 'authchain-reject';
  } else {
    const selected = isCreate
      ? []
      : rulebook.selectAuthEvents(pdu, ctx);
    if (!sameIdSet([...declaredAuth], selected)) {
      verdict = 'authchain-reject';
    } else {
      verdict = rulebook.authorized(pdu, ctx);
    }
  }
  const rejected = conflicted || verdict !== 'ok';

  // 11. resolved state rows (contents from validated PDUs only — a state
  // row without a validated event behind it is never written).
  const rows: StateRowInput[] = [];
  for (const [k, eid] of resolved) {
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
    // deno-lint-ignore no-explicit-any
    const branchNames = new Set(branchRows.rows.map((r: any) => String(r.name)));
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
        await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
          `fan-in ${i + 2}/${prevs.length} for ${eventId}`,
        ]);
      }
    }

    // event row: the received PDU stored VERBATIM as canonical text,
    // plus indexed columns (depth, prev/auth events, hashes,
    // signatures, rejected). canonical_json is text, not jsonb.
    await c.query(
      'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);',
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

    // delete consumed prev branches unless the test hook keeps them;
    // main is never an extremity and stays at the schema-genesis commit.
    // On conflict refusal the parents stay alive (the room stays forked;
    // the refused tip joins them — nothing is dropped or guessed).
    if (!opts.keepPrevBranches && !conflicted) {
      for (const p of prevs) {
        await c.query(`SELECT DOLT_BRANCH('-D', '${ident(p.branch!)}');`);
      }
    }
    return { commitHash, newBranch };
  });

  // event_id <-> commit_hash bijection + current branch (D8), flagged
  // rejected when refused (prev resolution needs the id; rejected events
  // never enter `state`).
  await withDb(SERVER_DB, async (c) => {
    await c.query(
      'INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected) VALUES ($1, $2, $3, $4, $5);',
      [eventId, roomId, commitHash, newBranch, rejected],
    );
  });

  // core→hat signal, then return — or surface the conflict refusal (the
  // DAG was adopted; the room stays forked; nothing was guessed).
  for (const l of appliedListeners) {
    try {
      l(roomId, eventId);
    } catch (e) {
      console.error('applied listener error:', e);
    }
  }
  if (conflicted) {
    throw new Error(
      'M_UNRESOLVED_CONFLICT: concurrent edits to one state key are refused (stub)',
    );
  }
  if (verdict !== 'ok') {
    throw new Error(
      (verdict === 'authchain-reject' ? 'M_AUTHCHAIN_REJECT: ' : 'M_STATE_REJECT: ') + eventId,
    );
  }
  return { event_id: eventId, commit_hash: commitHash };
}
