// api/engine/federation/history.ts — the reading walk and the backfill
// client (§3.10). A room database is a BOOK: its branches are
// chapter0, chapter1, chapter2, … (even = history, growing toward the
// past; odd = a stay, growing toward the future) plus the x* event
// branches. A *cursor* is (chapter, offset) — offset = seq on an odd
// chapter, branch_pos on an even one — and one primitive, step(cursor,
// direction), moves one event at a time; /messages (both directions),
// /context and left-room reads are all loops over it. Tokens are
// c<n>_<offset>; a legacy s<n> maps by lookup (the event_index row with
// seq = n, or the greatest seq ≤ n in the room, gives its era).
//
// The frontier: an event of the chapter (or of its history branch) one
// of whose prev_events is not grounded (groundingOf — the same test
// resolvePrevs uses, so the two never disagree) while the room has
// other servers. Then ONE backfill per request: GET /backfill at a room
// server (seniority order; next on failure), states computed forward in
// memory (one /state_ids at the page's oldest), commits written
// backward with the precomputed states — the history chapter grows
// toward the past, so pages have no seam. When the page's oldest
// event's prevs are all grounded (the overlap), the chapter is
// complete and fetching stops.
import { config, serverName } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { getRulebook, stateKeyOf, type StateMap } from '#engine/policy.ts';
import {
  chapterHead,
  groundingOf,
  lookupRoom,
  parseStreamToken,
  serversInRoom,
} from '#engine/room.ts';
import { ident } from '#engine/db.ts';
import { materialize, type StateRowInput } from '#engine/materialize.ts';
import { checkRemoteFormat, domainOf } from './pdu.ts';
import { getVerifyKey } from './keys.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { verifyPduSignature } from '#engine/signing.ts';
import { contentHashOf } from '#engine/signing-primitives.js';
import { redact } from '#engine/eventid.ts';
import { federationRequest } from './client.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { type EventIndexRow, eventIndexRowOf } from '#engine/event-format.ts';
import type { Pdu } from '#engine/pdu.ts';

export type Cursor = { chapter: number; offset: number };

// --- the walk ------------------------------------------------------------------

export type StepResult =
  | { kind: 'event'; row: WalkRow; cursor: Cursor }
  | { kind: 'frontier'; cursor: Cursor; prevIds: string[] }
  | { kind: 'end' };

// One step through the book (§3.10). Backward: the live stay in seq
// DESC, then its history chapter in branch_pos ASC (0 = most recent),
// then the previous stay, and so on. A history chapter's exhausted tip
// with an ungrounded prev is a FRONTIER — the caller may backfill once
// and re-step; if the gap is still open the request ends here with the
// frontier cursor. Forward is the mirror — never a restart at the
// beginning.
export async function step(
  roomId: string,
  cursor: Cursor,
  dir: 'b' | 'f',
): Promise<StepResult> {
  let { chapter, offset } = cursor;
  for (;;) {
    if (dir === 'b') {
      if (chapter % 2 === 1) {
        // a stay: seq DESC from the offset (latestInStay is strict, so
        // the offset is the exclusive upper bound — the walk start
        // passes latest+1, a step passes the just-read event's seq)
        const row = await latestInStay(
          roomId,
          `chapter${chapter}`,
          offset === 0 ? null : offset,
        );
        if (row !== null) {
          return { kind: 'event', row, cursor: { chapter, offset: row.seq! } };
        }
        // past the stay's opening → its history chapter (fresh: −1)
        chapter -= 1;
        offset = -1;
        continue;
      }
      // a history chapter: branch_pos ASC from the offset
      const row = await inHistory(
        roomId,
        `chapter${chapter}`,
        offset < 0 ? null : offset,
        'b',
      );
      if (row !== null) {
        return {
          kind: 'event',
          row,
          cursor: { chapter, offset: row.branch_pos! },
        };
      }
      // exhausted: the tip's prevs decide — frontier or the previous stay
      const frontier = await frontierOf(roomId, chapter);
      if (frontier !== null) {
        return {
          kind: 'frontier',
          cursor: { chapter, offset },
          prevIds: frontier,
        };
      }
      if (chapter >= 2) {
        chapter -= 1;
        offset = 0;
        continue;
      }
      return { kind: 'end' };
    }
    // forward
    if (chapter % 2 === 1) {
      const row = await firstInStay(roomId, `chapter${chapter}`, offset);
      if (row !== null) {
        return { kind: 'event', row, cursor: { chapter, offset: row.seq! } };
      }
      return { kind: 'end' }; // the stay's tip — caught up
    }
    const row = await inHistory(roomId, `chapter${chapter}`, offset, 'f');
    if (row !== null) {
      return {
        kind: 'event',
        row,
        cursor: { chapter, offset: row.branch_pos! },
      };
    }
    // the history chapter's root (most recent) → the next stay
    chapter += 1;
    offset = 0;
  }
}

// The walk's START for a backward read: the chapter head (the live
// stay's tip, or the archived stay's tip).
export async function walkStart(roomId: string): Promise<Cursor | null> {
  const head = await chapterHead(roomId);
  if (head === null) return null;
  const m = /^chapter(\d+)$/.exec(head);
  if (!m) return null;
  const chapter = Number(m[1]);
  const row = await latestInStay(roomId, head, null);
  if (row === null) return { chapter, offset: 0 };
  return { chapter, offset: row.seq! + 1 };
}

// The cursor of an event by id (for /context's pivot and legacy tokens).
export async function cursorOfEvent(
  roomId: string,
  eventId: string,
): Promise<Cursor | null> {
  const row = await chapterOfEvent(roomId, eventId);
  if (row === null || row.era === null) return null;
  const m = /^chapter(\d+)$/.exec(row.era);
  if (!m) return null;
  if (row.seq !== null) return { chapter: Number(m[1]), offset: row.seq };
  // a history row: era names the stay it belongs to (§3.10), so its
  // cursor's chapter is the history chapter below that stay; the
  // offset is its branch_pos
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT branch_pos FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return r.rows.length === 0 || r.rows[0].branch_pos == null
      ? null
      : { chapter: Number(m[1]) - 1, offset: Number(r.rows[0].branch_pos) };
  });
}

// --- the event_index reads ---------------------------------------------------

type WalkRow = EventIndexRow;

async function latestInStay(
  roomId: string,
  chapter: string,
  beforeSeq: number | null,
): Promise<WalkRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = beforeSeq === null
      ? await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND era = $2 AND rejected = FALSE AND soft_failed = FALSE AND seq IS NOT NULL
         ORDER BY seq DESC LIMIT 1;`,
        [roomId, chapter],
      )
      : await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND era = $2 AND rejected = FALSE AND soft_failed = FALSE AND seq < $3
         ORDER BY seq DESC LIMIT 1;`,
        [roomId, chapter, beforeSeq],
      );
    return r.rows.length === 0 ? null : eventIndexRowOf(r.rows[0]);
  });
}

async function firstInStay(
  roomId: string,
  chapter: string,
  afterSeq: number | null,
): Promise<WalkRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = afterSeq === null
      ? await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND era = $2 AND rejected = FALSE AND soft_failed = FALSE AND seq IS NOT NULL
         ORDER BY seq ASC LIMIT 1;`,
        [roomId, chapter],
      )
      : await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND era = $2 AND rejected = FALSE AND soft_failed = FALSE AND seq > $3
         ORDER BY seq ASC LIMIT 1;`,
        [roomId, chapter, afterSeq],
      );
    return r.rows.length === 0 ? null : eventIndexRowOf(r.rows[0]);
  });
}

async function inHistory(
  roomId: string,
  chapter: string,
  afterPos: number | null,
  dir: 'b' | 'f',
): Promise<WalkRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = afterPos === null
      ? await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND branch_name = $2 AND rejected = FALSE AND soft_failed = FALSE
         ORDER BY branch_pos ${dir === 'b' ? 'ASC' : 'DESC'} LIMIT 1;`,
        [roomId, chapter],
      )
      : await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND branch_name = $2 AND rejected = FALSE AND soft_failed = FALSE
           AND branch_pos ${dir === 'b' ? '>' : '<'} $3
         ORDER BY branch_pos ${dir === 'b' ? 'ASC' : 'DESC'} LIMIT 1;`,
        [roomId, chapter, afterPos],
      );
    return r.rows.length === 0 ? null : eventIndexRowOf(r.rows[0]);
  });
}

async function pduOf(roomId: string, eventId: string): Promise<Pdu | null> {
  const room = await lookupRoom(roomId);
  if (room === null) return null;
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return null;
    return await withDb(room.dbName, async (rc) => {
      const rr = await rc.query(
        `SELECT canonical_json FROM events AS OF '${
          String(r.rows[0].commit_hash)
        }' WHERE event_id = $1;`,
        [eventId],
      );
      if (rr.rows.length === 0) return null;
      return (typeof rr.rows[0].canonical_json === 'string'
        ? JSON.parse(String(rr.rows[0].canonical_json))
        : rr.rows[0].canonical_json) as Pdu;
    });
  });
}

async function chapterOfEvent(
  roomId: string,
  eventId: string,
): Promise<{ era: string | null; seq: number | null } | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT era, seq FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return r.rows.length === 0 ? null : {
      era: r.rows[0].era == null ? null : String(r.rows[0].era),
      seq: r.rows[0].seq == null ? null : Number(r.rows[0].seq),
    };
  });
}

// --- tokens --------------------------------------------------------------------

// c<n>_<offset> — the chapter number and the offset on it (seq on an
// odd chapter, branch_pos on an even one). A chapter number is a stable
// identity for the life of the room (never reused, §3.6c), so a token
// minted before a re-join still means the same place after it.
export function formatCursorToken(cursor: Cursor): string {
  return `c${cursor.chapter}_${cursor.offset}`;
}

// A legacy s<n> on /messages//context (including prev_batch minted by
// /sync) maps by LOOKUP: the event_index row with seq = n (or the
// greatest seq ≤ n in the room) gives its era → the cursor — never
// "the current chapter", which would be wrong for a token minted
// before a re-join.
export async function cursorForToken(
  roomId: string,
  token: string,
  dir: 'b' | 'f',
): Promise<Cursor | null> {
  const m = /^c(\d+)_(\d+)$/.exec(token);
  if (m) return { chapter: Number(m[1]), offset: Number(m[2]) };
  // the legacy grammar is the event-stream part of any /sync token
  // (s<e>_p<p>_t<t>_r<r>_a<a> — what /sync mints as next_batch and
  // prev_batch), never just the bare s<n>
  const st = parseStreamToken(token);
  if (st !== null) {
    const n = st.eSeq;
    return await withDb(serverDb(), async (c) => {
      const r = await c.query(
        `SELECT era, seq FROM event_index
         WHERE room_id = $1 AND seq <= $2 AND seq IS NOT NULL
         ORDER BY seq DESC LIMIT 1;`,
        [roomId, n],
      );
      if (r.rows.length === 0) return null;
      const era = r.rows[0].era == null ? null : String(r.rows[0].era);
      if (era === null) return null;
      const cm = /^chapter(\d+)$/.exec(era);
      if (!cm) return null;
      // the legacy s<n> convention is inclusive going backward (the old
      // `seq <= n`) and exclusive going forward (`seq > n`); the walk's
      // steps are strict on both sides, so a backward start is nudged
      // past n to land ON n
      const seq = Number(r.rows[0].seq);
      return { chapter: Number(cm[1]), offset: dir === 'b' ? seq + 1 : seq };
    });
  }
  // neither form: a client error, not a silent restart from the
  // beginning (the silence is what hid dropped from/to)
  throw new MatrixError(
    400,
    'M_INVALID_PARAM',
    `unknown pagination token: ${token}`,
  );
}

// --- the frontier + the backfill client -----------------------------------------

// The chapter's frontier: the ungrounded prev ids of the chapter's tip
// (or of its opening event when the history chapter is still empty) —
// null when every prev is grounded (the gap is closed) or the room has
// no other server to ask.
export async function frontierOf(
  roomId: string,
  chapter: number,
): Promise<string[] | null> {
  const others = (await serversInRoom(roomId)).filter((d) =>
    d !== serverName()
  );
  if (others.length === 0) return null;
  // the event whose prevs face the gap: the history chapter's tip (the
  // oldest fetched event) — or, while the chapter is still empty, the
  // NEXT stay's opening event (a fresh join's prevs are the resident's;
  // a re-join's bridge the gap we missed)
  let facing: string | null = null;
  const tip = await inHistory(roomId, `chapter${chapter}`, null, 'f');
  if (tip !== null) {
    facing = tip.event_id;
  } else {
    const opening = await firstInStay(roomId, `chapter${chapter + 1}`, null);
    facing = opening == null || opening.event_id == null
      ? null
      : opening.event_id;
  }
  if (facing === null) return null;
  const pdu = await pduOf(roomId, facing);
  if (pdu === null) return null;
  const ungrounded: string[] = [];
  for (const pid of pdu.prev_events == null ? [] : pdu.prev_events) {
    const g = await groundingOf(roomId, pid);
    if (g !== 'own') ungrounded.push(pid);
  }
  return ungrounded.length === 0 ? null : ungrounded;
}

// ONE backfill per trigger: fetch the page at a room server (seniority
// order — the earliest joined member's server first, next on failure),
// write the commits backward with the precomputed states. Returns
// 'filled' (the gap moved — the walk may continue), 'open' (still
// unresolved — the request ends at the frontier), or 'complete' (the
// page's oldest event's prevs are all grounded — the chapter is done).
export async function backfill(
  roomId: string,
  chapter: number,
  prevIds: string[],
): Promise<'filled' | 'open' | 'complete'> {
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  const fed = config().federation;
  // seniority: the room's servers by the seq of each server's earliest
  // joined member event, minus ourselves
  const seniority = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT user_id, seq FROM room_membership WHERE room_id = $1 AND membership = 'join' ORDER BY seq ASC;`,
      [roomId],
    );
    const domains = new Map<string, number>();
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const uid = String(row.user_id);
      const at = uid.indexOf(':');
      if (at < 0) continue;
      const d = uid.slice(at + 1);
      if (!domains.has(d)) domains.set(d, Number(row.seq));
    }
    return [...domains.entries()]
      .filter(([d]) => d !== serverName())
      .sort((a, b) => a[1] - b[1])
      .map(([d]) => d);
  });
  let page: Pdu[] | null = null;
  let answeredBy = '';
  for (const server of seniority) {
    try {
      const res = await federationRequest({
        destination: server,
        method: 'GET',
        path: `/_matrix/federation/v1/backfill/${encodeURIComponent(roomId)}?${
          prevIds.map((v) => `v=${encodeURIComponent(v)}`).join('&')
        }&limit=${fed.backfillbatch}`,
        body: null,
      });
      const jres = res.json as { pdus?: unknown[] } | null;
      const pdus =
        (jres == null || jres.pdus == null ? [] : jres.pdus) as Pdu[];
      page = pdus;
      answeredBy = server;
      break;
    } catch {
      continue; // next on failure
    }
  }
  if (page === null || page.length === 0) return 'open';
  // vet every answered event (§3.2's checks); the bad ones are dropped
  const spec = getRulebook(room.roomVersion).spec;
  const vetted: Pdu[] = [];
  for (const pdu of page) {
    try {
      checkRemoteFormat(pdu, spec, { exemptPrevAuthLimits: true });
    } catch {
      continue;
    }
    const eventId = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      room.roomVersion,
    );
    (pdu as unknown as Record<string, unknown>).event_id = eventId;
    const { event_id: _a, ...noId } = pdu as unknown as Record<string, unknown>;
    void _a;
    const hashOk = (await contentHashOf(noId)) === pdu.hashes?.sha256;
    if (!hashOk) {
      const redacted = redact(
        pdu as unknown as Record<string, unknown>,
        room.roomVersion,
      );
      for (const k of Object.keys(pdu)) {
        delete (pdu as unknown as Record<string, unknown>)[k];
      }
      Object.assign(pdu, redacted);
    }
    const senderDomain = domainOf(String(pdu.sender));
    const pduSigs = pdu.signatures == null ? {} : pdu.signatures;
    const senderSigs = pduSigs[senderDomain] == null
      ? {}
      : pduSigs[senderDomain];
    let sigOk = false;
    if (senderDomain === serverName()) {
      // our own event riding the page (a re-join's gap or snapshot can
      // carry it) — verify with the tenant key, never a self-dial
      const key = await getTenantKey();
      for (const kid of Object.keys(senderSigs)) {
        if (
          await verifyPduSignature(
            pdu,
            key.publicKey,
            senderDomain,
            kid,
            room.roomVersion,
          )
        ) {
          sigOk = true;
          break;
        }
      }
    }
    if (!sigOk) {
      for (const kid of Object.keys(senderSigs)) {
        try {
          const key = await getVerifyKey(
            senderDomain,
            kid,
            spec.enforceKeyValidity ? Number(pdu.origin_server_ts) : 0,
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
        } catch { /* next */ }
      }
    }
    if (!sigOk) continue;
    vetted.push(pdu);
  }
  if (vetted.length === 0) return 'open';
  // newest-first within the page (the chapter grows toward the past)
  vetted.sort((a, b) => b.depth - a.depth);
  const oldest = vetted[vetted.length - 1];
  // the overlap test: the page's oldest event's prevs all grounded?
  let complete = true;
  for (const pid of oldest.prev_events == null ? [] : oldest.prev_events) {
    if ((await groundingOf(roomId, pid)) !== 'own') {
      complete = false;
      break;
    }
  }
  // the states, computed FORWARD in memory: one /state_ids at the
  // page's oldest event (skipped on the overlap — the state comes from
  // the grounded commits instead), then each event applied in turn
  const stateAfter = new Map<string, StateRowInput>();
  const evidence: Pdu[] = [];
  if (complete) {
    // resolve from the grounded prevs' commits
    const sets: StateMap[] = [];
    const room2 = await lookupRoom(roomId);
    for (const pid of oldest.prev_events == null ? [] : oldest.prev_events) {
      const ch = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [roomId, pid],
        );
        return r.rows.length ? String(r.rows[0].commit_hash) : null;
      });
      if (ch === null) continue;
      const m: StateMap = new Map();
      await withDb(room2!.dbName, async (c) => {
        const r = await c.query(
          `SELECT type, state_key, event_id FROM state AS OF '${ch}';`,
        );
        // deno-lint-ignore no-explicit-any
        for (const row of r.rows as any[]) {
          m.set(
            stateKeyOf(
              String(row.type),
              String(row.state_key == null ? '' : row.state_key),
            ),
            String(row.event_id),
          );
        }
      });
      sets.push(m);
    }
    const rulebook = getRulebook(room.roomVersion);
    const resolved = rulebook.resolveState(sets, {
      get: () => undefined,
      isRejected: () => false,
    });
    for (const [k, eid] of resolved) {
      const sep = k.indexOf('');
      const pdu = await pduOf(roomId, eid);
      if (pdu === null) continue;
      stateAfter.set(k, {
        type: k.slice(0, sep),
        stateKey: k.slice(sep + 1),
        eventId: eid,
        content: pdu.content == null ? {} : pdu.content,
      });
    }
  } else {
    // one /state_ids at the page's oldest event (+ /event for unknown
    // ids, stored 'evidence' in the same commit as the event they ground)
    const res = await federationRequest({
      destination: answeredBy,
      method: 'GET',
      path: `/_matrix/federation/v1/state_ids/${
        encodeURIComponent(roomId)
      }?event_id=${encodeURIComponent(String(oldest.event_id))}`,
      body: null,
    });
    const j = res.json as { pdu_ids?: unknown[]; auth_chain_ids?: unknown[] };
    const pduIds = j.pdu_ids == null ? [] : j.pdu_ids;
    const authChainIds = j.auth_chain_ids == null ? [] : j.auth_chain_ids;
    const wanted = [
      ...new Set([
        ...(pduIds as string[]).map(String),
        ...(authChainIds as string[]).map(String),
      ]),
    ];
    for (const id of wanted) {
      if ((await groundingOf(roomId, id)) !== 'unknown') continue;
      try {
        const er = await federationRequest({
          destination: answeredBy,
          method: 'GET',
          path: `/_matrix/federation/v1/event/${encodeURIComponent(id)}`,
          body: null,
        });
        const erj = er.json as { pdus?: unknown[] } | null;
        const pdus = (erj == null || erj.pdus == null ? [] : erj.pdus) as Pdu[];
        if (pdus.length === 0) continue;
        const ev = pdus[0];
        (ev as unknown as Record<string, unknown>).event_id = await eventIdFor(
          ev as unknown as Record<string, unknown>,
          room.roomVersion,
        );
        evidence.push(ev);
      } catch {
        continue;
      }
    }
    // the state at the oldest event (its "before" state = the answer's
    // pdu_ids rows) — then each event applied in turn, forward
    for (const id of pduIds as string[]) {
      const held = evidence.find((e) => String(e.event_id) === id);
      const ev = held == null ? await pduOf(roomId, id) : held;
      if (ev === null || ev === undefined || ev.state_key === undefined) {
        continue;
      }
      stateAfter.set(stateKeyOf(String(ev.type), String(ev.state_key)), {
        type: String(ev.type),
        stateKey: String(ev.state_key),
        eventId: id,
        content: ev.content == null ? {} : ev.content,
      });
    }
  }
  // apply the page FORWARD from the oldest, then write the commits
  // BACKWARD (newest first) with the precomputed states
  const statesByEvent = new Map<string, StateRowInput[]>();
  for (let i = vetted.length - 1; i >= 0; i--) {
    const ev = vetted[i];
    const rows = [...stateAfter.values()];
    statesByEvent.set(String(ev.event_id), rows);
    if (ev.state_key !== undefined) {
      stateAfter.set(stateKeyOf(String(ev.type), String(ev.state_key)), {
        type: String(ev.type),
        stateKey: String(ev.state_key),
        eventId: String(ev.event_id),
        content: ev.content == null ? {} : ev.content,
      });
    }
  }
  // write the commits: newest first, branch_pos = the commit position
  const chapterName = `chapter${chapter}`;
  // §3.10: a history row's era is the STAY it belongs to — the stay
  // above the history chapter being fetched into (chapter2k's rows
  // carry era = chapter2k+1); branch_name carries the history chapter
  const era = `chapter${chapter + 1}`;
  const room2 = await lookupRoom(roomId);
  await withDb(room2!.dbName, async (c) => {
    await c.query(`SELECT DOLT_CHECKOUT('${ident(chapterName)}');`);
    let pos = await withDb(serverDb(), async (s) => {
      const r = await s.query(
        `SELECT COALESCE(MAX(branch_pos), -1) AS m FROM event_index WHERE room_id = $1 AND branch_name = $2;`,
        [roomId, chapterName],
      );
      return Number(r.rows[0].m) + 1;
    });
    for (let vi = 0; vi < vetted.length; vi++) {
      const ev = vetted[vi];
      const eventId = String(ev.event_id);
      // the OVERLAP (§3.10): the first fetched event we already hold —
      // grounded with a commit of its own (a live row of an earlier
      // stay, or already on a history chapter) — ENDS the fetching for
      // good: first chapter wins, nothing is relocated, and the walk
      // reaches it in its own chapter. Everything older stays for the
      // previous chapter's fetch.
      const g = await groundingOf(roomId, eventId);
      if (g === 'own') {
        complete = true;
        break;
      }
      // unknown or held-as-evidence → promoted onto this chapter (§3.2:
      // commit, state_commit_hash, branch_name/branch_pos/era; seq NULL)
      const existing = await withDb(serverDb(), async (s) => {
        const r = await s.query(
          'SELECT seq, branch_name, rejected_reason FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [roomId, eventId],
        );
        return r.rows.length === 0 ? null : {
          seq: r.rows[0].seq == null ? null : Number(r.rows[0].seq),
          branchName: r.rows[0].branch_name == null
            ? null
            : String(r.rows[0].branch_name),
          rejectedReason: r.rows[0].rejected_reason == null
            ? null
            : String(r.rows[0].rejected_reason),
        };
      });
      if (existing !== null && existing.seq !== null) {
        complete = true;
        break; // a live row — the overlap, same as above
      }
      // the evidence rows fetched for the OLDEST event land in ITS
      // commit (the event they ground — r5, fable: GC)
      const isOldest = vi === vetted.length - 1;
      if (isOldest) {
        for (const evd of evidence) {
          await c.query(
            'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING;',
            [
              String(evd.event_id),
              evd.type,
              evd.state_key == null ? null : evd.state_key,
              evd.sender,
              evd.origin_server_ts,
              evd.depth,
              JSON.stringify(evd.prev_events == null ? [] : evd.prev_events),
              JSON.stringify(evd.auth_events == null ? [] : evd.auth_events),
              JSON.stringify(evd.hashes == null ? {} : evd.hashes),
              JSON.stringify(evd.signatures == null ? {} : evd.signatures),
              false,
              false,
              canonicalJson(evd as unknown as Record<string, unknown>),
            ],
          );
        }
      }
      // standing per §3.2 (rejected/soft-failed decided as for any
      // event — the page was vetted; auth-chain failures mark rejected)
      await c.query(
        'INSERT INTO events (event_id, type, state_key, sender, origin_ts, depth, prev_events, auth_events, hashes, signatures, rejected, soft_failed, canonical_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING;',
        [
          eventId,
          ev.type,
          ev.state_key == null ? null : ev.state_key,
          ev.sender,
          ev.origin_server_ts,
          ev.depth,
          JSON.stringify(ev.prev_events == null ? [] : ev.prev_events),
          JSON.stringify(ev.auth_events == null ? [] : ev.auth_events),
          JSON.stringify(ev.hashes == null ? {} : ev.hashes),
          JSON.stringify(ev.signatures == null ? {} : ev.signatures),
          false,
          false,
          canonicalJson(ev as unknown as Record<string, unknown>),
        ],
      );
      const stateRows = statesByEvent.get(eventId);
      await materialize(c, stateRows == null ? [] : stateRows);
      const commit = await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
        `history ${eventId} type ${String(ev.type)}`,
      ]);
      const commitHashVal = Object.values(commit.rows[0])[0];
      const commitHash = String(commitHashVal == null ? '' : commitHashVal);
      await withDb(serverDb(), async (s) => {
        await s.query(
          `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
             rejected_reason, origin, added_ms, era, branch_pos, state_commit_hash, seq)
           VALUES ($1, $2, $3, $4, FALSE, FALSE, NULL, $5, $6, $7, $8, $9, NULL)
           ON CONFLICT (event_id) DO UPDATE SET commit_hash = $3, branch_name = $4, branch_pos = $8, era = $7, state_commit_hash = $9;`,
          [
            eventId,
            roomId,
            commitHash,
            chapterName,
            answeredBy,
            Date.now(),
            era,
            pos,
            commitHash,
          ],
        );
        if (isOldest) {
          for (const evd of evidence) {
            await s.query(
              `INSERT INTO event_index (event_id, room_id, commit_hash, branch_name, rejected, soft_failed,
                 rejected_reason, origin, added_ms, era, seq)
               VALUES ($1, $2, $3, NULL, FALSE, FALSE, NULL, $4, $5, NULL, NULL)
               ON CONFLICT (event_id) DO NOTHING;`,
              [
                String(evd.event_id),
                roomId,
                commitHash,
                answeredBy,
                Date.now(),
              ],
            );
          }
        }
      });
      pos += 1;
    }
  });
  return complete ? 'complete' : 'filled';
}

export { chapterOfEvent, pduOf };
