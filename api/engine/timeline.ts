import { serverDb, withDb } from './db.ts';
import {
  eventIndexRow,
  formatStreamToken,
  lookupRoom,
  stateAtSeq,
} from './room.ts';
import { canSeeEvent } from './visibility.ts';
import {
  clientEvent,
  type EventIndexRow,
  type ThreadBundle,
} from './event-format.ts';
import type { Pdu } from './pdu.ts';

// Load one event's stored PDU by id, AS OF the commit that carries it
// (event rows live on x* branches — `main` only holds `state`).
export async function pduById(
  dbName: string,
  commitHash: string,
  eventId: string,
): Promise<Pdu | null> {
  if (!/^[a-z0-9]+$/i.test(commitHash)) {
    throw new Error('E_BAD_HASH: ' + commitHash);
  }
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT canonical_json FROM events AS OF '${commitHash}' WHERE event_id = $1;`,
      [eventId],
    );
    if (r.rows.length === 0) return null;
    const v = r.rows[0].canonical_json;
    return (typeof v === 'string' ? JSON.parse(v) : v) as Pdu;
  });
}

// The thread aggregation for one event when it is a thread root (band C
// D7): latest child, child count, and the viewer's participation
// (threading.md:199-201 — root sender or any m.thread child sender).
// null when the event has no m.thread children. The child-row query is
// inline so relations.ts can depend on THIS module (for /relations and
// /threads rendering) without a cycle.
async function threadBundle(
  dbName: string,
  row: EventIndexRow,
  rootSender: string,
  viewer: string,
): Promise<{ latestRow: EventIndexRow; bundle: ThreadBundle } | null> {
  const children = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT event_id, seq FROM relations
       WHERE room_id = $1 AND relates_to = $2 AND rel_type = 'm.thread'
       ORDER BY seq DESC;`,
      [row.room_id, row.event_id],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((x) => ({
      eventId: String(x.event_id),
      seq: Number(x.seq),
    }));
  });
  if (children.length === 0) return null;
  const latestRow = await eventIndexRow(row.room_id, children[0].eventId);
  if (latestRow === null) return null;
  let participated = rootSender === viewer;
  if (!participated) {
    for (const child of children) {
      const idx = await eventIndexRow(row.room_id, child.eventId);
      if (idx === null) continue;
      const childPdu = await pduById(dbName, idx.commit_hash, child.eventId);
      if (childPdu?.sender === viewer) {
        participated = true;
        break;
      }
    }
  }
  return {
    latestRow,
    bundle: {
      latest_event: {}, // filled by the caller (one-level render)
      count: children.length,
      current_user_participated: participated,
    },
  };
}

// The full client rendering of an event_index row: the stored PDU plus
// the redaction treatment when redacted_by is set (the redaction event's
// own client form lands in unsigned.redacted_because). One level deep —
// a redaction event's own redaction is not followed, and a thread root's
// bundled latest_event carries no bundle of its own (threading.md
// :190-194).
export async function clientEventForRow(
  dbName: string,
  roomVersion: string,
  row: EventIndexRow,
  viewer?: { userId: string; deviceId: string | null; membership?: string },
  bundleThreads = true,
): Promise<Record<string, unknown> | null> {
  const pdu = await pduById(dbName, row.commit_hash, row.event_id);
  if (!pdu) return null;
  let redaction:
    | { roomVersion: string; event: Record<string, unknown> }
    | undefined;
  if (row.redacted_by != null) {
    const rIdx = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT * FROM event_index WHERE room_id = $1 AND event_id = $2;',
        [row.room_id, row.redacted_by],
      );
      return r.rows.length ? r.rows[0] : null;
    });
    if (rIdx) {
      const rPdu = await pduById(
        dbName,
        String(rIdx.commit_hash),
        row.redacted_by,
      );
      if (rPdu) {
        redaction = {
          roomVersion,
          event: clientEvent(rPdu, {
            event_id: String(rIdx.event_id),
            room_id: String(rIdx.room_id),
            commit_hash: String(rIdx.commit_hash),
            rejected: rIdx.rejected === true,
            soft_failed: rIdx.soft_failed === true,
            seq: Number(rIdx.seq),
            state_commit_hash: rIdx.state_commit_hash == null
              ? null
              : String(rIdx.state_commit_hash),
            redacted_by: rIdx.redacted_by == null
              ? null
              : String(rIdx.redacted_by),
            txn_device: rIdx.txn_device == null
              ? null
              : String(rIdx.txn_device),
            txn_id: rIdx.txn_id == null ? null : String(rIdx.txn_id),
          }, viewer),
        };
      }
    }
  }
  // Band C (D7): bundle unsigned.m.relations.m.thread on thread roots —
  // one level deep, so the bundled latest_event renders bundle-free.
  let thread: ThreadBundle | undefined;
  if (bundleThreads) {
    const data = await threadBundle(
      dbName,
      row,
      String(pdu.sender),
      viewer?.userId ?? '',
    );
    if (data !== null) {
      const latest = await clientEventForRow(
        dbName,
        roomVersion,
        data.latestRow,
        viewer,
        false,
      );
      if (latest !== null) {
        thread = { ...data.bundle, latest_event: latest };
      }
    }
  }
  return clientEvent(pdu, row, viewer, redaction, thread);
}

// Maps a commit to the events row it added (the commit=event invariant:
// exactly one added row). Returns the parsed canonical_json, or null for
// non-event commits. Shared by timeline.messages (Mode B) and syncfeed.
export async function eventAtCommit(
  c: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
  commitHash: string,
): Promise<Record<string, unknown> | null> {
  const d = await c.query(
    `SELECT * FROM dolt_diff('${commitHash}~', '${commitHash}', 'events');`,
  );
  // deno-lint-ignore no-explicit-any
  for (const dr of d.rows as any[]) {
    if (dr.diff_type !== 'added') continue;
    // F0: canonical_json is verbatim TEXT (not jsonb) — parse it.
    const v = dr.to_canonical_json as unknown;
    return (typeof v === 'string' ? JSON.parse(v) : v) as Record<
      string,
      unknown
    >;
  }
  return null;
}

// Current state lives on `main` (republished by ingest / reresolveFromDag
// whenever the extremity set changes) — readers never pick a branch.
export async function stateNow(dbName: string): Promise<unknown[]> {
  return await withDb(dbName, async (c) => {
    await c.query("SELECT DOLT_CHECKOUT('main');");
    const r = await c.query('SELECT * FROM state;');
    return r.rows;
  });
}

// --- M4: /messages (plan §3f) ----------------------------------------------

export interface MessagesWindow {
  roomId: string;
  userId: string;
  deviceId: string | null;
  // read position: null (joined) or the leave/ban seq — the window clamps
  // to it (left users read as of their leave; dir=f from >= it is empty)
  leaveAt: number | null;
  dir: 'b' | 'f';
  fromSeq: number | null; // null = the dir's default (b: latest, f: 0)
  toSeq: number | null;
  limit: number; // default 10
  lazyLoadMembers: boolean;
  // Band C: the RoomEventFilter's contains_url (room_event_filter.yaml
  // :53-56 — plan reads it as content.url being a string); undefined =
  // url not considered.
  containsUrl?: boolean;
}

export interface MessagesResult {
  chunk: Record<string, unknown>[];
  start: string;
  end?: string;
  state?: Record<string, unknown>[];
}

// Window by seq over event_index (not dolt.log), redaction applied at
// read, visibility per event (canSeeEvent). Bounds per Synapse's
// pagination (transcribed at plan §3f): dir=f -> from < x <= to;
// dir=b -> from >= x > to. The limit cuts the RAW window first (spec: an
// empty/short chunk does not imply no more events). `end` follows
// Synapse's rule (pagination.py:668-706, transcribed 2026-09-19): omitted
// only when the raw page is EMPTY and there is no further page — a
// non-empty raw page always carries end, even when the client filter
// emptied the chunk (there might be more in the next batch).
export async function messages(w: MessagesWindow): Promise<MessagesResult> {
  const room = await lookupRoom(w.roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + w.roomId);
  const limit = Math.max(0, Math.floor(w.limit));
  const clamp = (seq: number) =>
    w.leaveAt === null ? seq : Math.min(seq, w.leaveAt);

  const nowSeq = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT MAX(seq) AS m FROM event_index WHERE room_id = $1;',
      [w.roomId],
    );
    return r.rows[0].m == null ? 0 : Number(r.rows[0].m);
  });

  const from = clamp(w.fromSeq ?? (w.dir === 'b' ? nowSeq : 0));
  const upper = clamp(w.toSeq ?? nowSeq);
  const lower = w.toSeq ?? -1;

  const rows = await withDb(serverDb(), async (c) => {
    if (w.dir === 'f') {
      if (from >= upper) return [];
      const r = await c.query(
        `SELECT * FROM event_index
         WHERE room_id = $1 AND rejected = FALSE AND soft_failed = FALSE
           AND seq > $2 AND seq <= $3
         ORDER BY seq ASC LIMIT $4;`,
        [w.roomId, from, upper, limit + 1],
      );
      return r.rows;
    }
    const r = await c.query(
      `SELECT * FROM event_index
       WHERE room_id = $1 AND rejected = FALSE AND soft_failed = FALSE
         AND seq <= $2 AND seq > $3
       ORDER BY seq DESC LIMIT $4;`,
      [w.roomId, from, lower, limit + 1],
    );
    return r.rows;
  });

  const hasMore = rows.length > limit;
  // deno-lint-ignore no-explicit-any
  const windowRows: EventIndexRow[] = rows.slice(0, limit).map((row: any) => ({
    event_id: String(row.event_id),
    room_id: String(row.room_id),
    commit_hash: String(row.commit_hash),
    rejected: row.rejected === true,
    soft_failed: row.soft_failed === true,
    seq: Number(row.seq),
    state_commit_hash: row.state_commit_hash == null
      ? null
      : String(row.state_commit_hash),
    redacted_by: row.redacted_by == null ? null : String(row.redacted_by),
    txn_device: row.txn_device == null ? null : String(row.txn_device),
    txn_id: row.txn_id == null ? null : String(row.txn_id),
  }));

  const chunk: Record<string, unknown>[] = [];
  for (const idx of windowRows) {
    const pdu = await pduById(room.dbName, idx.commit_hash, idx.event_id);
    if (!pdu) continue;
    if (w.containsUrl !== undefined) {
      const hasUrl = typeof ((pdu.content ?? {}) as Record<string, unknown>)
        .url === 'string';
      if (hasUrl !== w.containsUrl) continue;
    }
    if (
      !(await canSeeEvent(w.userId, w.roomId, {
        seq: idx.seq,
        type: pdu.type,
        stateKey: pdu.state_key,
      }))
    ) {
      continue;
    }
    const ev = await clientEventForRow(room.dbName, room.roomVersion, idx, {
      userId: w.userId,
      deviceId: w.deviceId,
    });
    if (ev) chunk.push(ev);
  }

  const result: MessagesResult = {
    chunk,
    start: formatStreamToken(from, 0),
  };
  if (windowRows.length > 0) {
    // the raw page is non-empty: end continues past the last raw row
    // (filter-emptied chunks included — Synapse's rule, see the header)
    const lastSeq = windowRows[windowRows.length - 1].seq;
    result.end = formatStreamToken(w.dir === 'f' ? lastSeq : lastSeq - 1, 0);
  } else if (hasMore) {
    // limit 0: nothing was consumed — end is the same position (no
    // progress, but nothing skipped either)
    result.end = formatStreamToken(from, 0);
  }
  // else: raw window empty and no further page — the true start of the
  // timeline; end is omitted.

  if (w.lazyLoadMembers) {
    const senders = new Set(chunk.map((e) => String(e.sender)));
    const endSeq = w.dir === 'f'
      ? (windowRows.length > 0 ? windowRows[windowRows.length - 1].seq : from)
      : from;
    const memberRows = ((await stateAtSeq(w.roomId, endSeq)) ?? []).filter(
      (r) => r.type === 'm.room.member' && senders.has(r.stateKey),
    );
    const state: Record<string, unknown>[] = [];
    for (const r of memberRows) {
      const idx = await eventIndexRow(w.roomId, r.eventId);
      if (!idx) continue;
      const ev = await clientEventForRow(room.dbName, room.roomVersion, idx, {
        userId: w.userId,
        deviceId: w.deviceId,
      });
      if (ev) state.push(ev);
    }
    result.state = state;
  }
  return result;
}
