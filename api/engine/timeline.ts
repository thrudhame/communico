import { ident, serverDb, withDb } from './db.ts';
import {
  chapterHeadForDb,
  eventIndexRow,
  lookupRoom,
  stateAtSeq,
} from './room.ts';
import { canSeeEvent } from './visibility.ts';
import {
  backfill,
  type Cursor,
  cursorForToken,
  formatCursorToken,
  step,
  walkStart,
} from './federation/history.ts';
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
  opts?: { omitRoomId?: boolean },
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
            seq: rIdx.seq == null ? null : Number(rIdx.seq),
            era: rIdx.era == null ? null : String(rIdx.era),
            branch_pos: rIdx.branch_pos == null
              ? null
              : Number(rIdx.branch_pos),
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
  return clientEvent(pdu, row, viewer, redaction, thread, opts);
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

// Current state lives on the current chapter (M5b, the book — main is
// the room's system branch): republished by ingest / reresolveFromDag
// whenever the extremity set changes; an archived room reads as of its
// close (chapterHeadForDb).
export async function stateNow(dbName: string): Promise<unknown[]> {
  const head = await chapterHeadForDb(dbName);
  if (head === null) return [];
  return await withDb(dbName, async (c) => {
    await c.query(`SELECT DOLT_CHECKOUT('${ident(head)}');`);
    const r = await c.query('SELECT * FROM state;');
    return r.rows;
  });
}

// --- M4: /messages (plan §3f); M5b: the chapter walk (§3.10) -----------

export interface MessagesWindow {
  roomId: string;
  userId: string;
  deviceId: string | null;
  // read position: null (joined) or the leave/ban seq — the walk starts
  // in the chapter of the user's latest membership event and never
  // enters a newer chapter or its history branch (r5, qwen)
  leaveAt: number | null;
  dir: 'b' | 'f';
  fromToken: string | null; // c<n>_<offset> or a legacy s<n>/sync token
  toToken: string | null;
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

// Time order across the book: newer = higher chapter; within a stay,
// higher seq; within a history chapter, LOWER branch_pos (0 = most
// recent). Returns < 0 when a is older than b.
function compareCursors(a: Cursor, b: Cursor): number {
  if (a.chapter !== b.chapter) return a.chapter - b.chapter;
  if (a.chapter % 2 === 1) return a.offset - b.offset;
  return b.offset - a.offset;
}

// The window is a loop over step() (§3.10): the raw page fills to the
// limit, ends at the create (end omitted), or stops at a frontier — ONE
// backfill per request, and if the gap is still open afterwards the
// request ends with the frontier cursor so the client comes back.
// Visibility per event (canSeeEvent), redaction at read, the chunk
// shaped by clientEventForRow as before.
export async function messages(w: MessagesWindow): Promise<MessagesResult> {
  const room = await lookupRoom(w.roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + w.roomId);
  const limit = Math.max(0, Math.floor(w.limit));

  // the clamp chapter for a left user: the chapter of their latest
  // membership event — the walk never enters a newer one
  let clampChapter: number | null = null;
  if (w.leaveAt !== null) {
    const eraRow = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT era FROM event_index WHERE room_id = $1 AND seq = $2;',
        [w.roomId, w.leaveAt],
      );
      return r.rows.length && r.rows[0].era != null
        ? String(r.rows[0].era)
        : null;
    });
    if (eraRow !== null) {
      const m = /^chapter(\d+)$/.exec(eraRow);
      if (m) clampChapter = Number(m[1]);
    }
  }

  // the start cursor
  let cursor: Cursor | null = null;
  if (w.fromToken !== null) {
    cursor = await cursorForToken(w.roomId, w.fromToken, w.dir);
  }
  if (cursor === null) {
    if (w.dir === 'b') {
      cursor = clampChapter !== null
        ? { chapter: clampChapter, offset: w.leaveAt! + 1 }
        : await walkStart(w.roomId);
    } else {
      // forward from the room's beginning (the deepest position of the
      // deepest chapter); a left user starts at their leave point
      cursor = clampChapter !== null
        ? { chapter: clampChapter, offset: Number.MAX_SAFE_INTEGER }
        : { chapter: 0, offset: Number.MAX_SAFE_INTEGER };
    }
  }
  if (cursor === null) {
    return { chunk: [], start: w.fromToken ?? '' };
  }
  const toCursor = w.toToken !== null
    ? await cursorForToken(w.roomId, w.toToken, w.dir)
    : null;

  const windowRows: { row: EventIndexRow; cursor: Cursor }[] = [];
  let endCursor: Cursor | null = null;
  let backfilled = false;
  for (;;) {
    if (windowRows.length >= limit) break;
    const r = await step(w.roomId, cursor, w.dir);
    if (r.kind === 'end') break;
    if (r.kind === 'frontier') {
      if (backfilled) {
        endCursor = r.cursor;
        break;
      }
      backfilled = true;
      const bf = await backfill(w.roomId, r.cursor.chapter, r.prevIds);
      if (bf === 'open') {
        // nobody answered — the gap stays open; end at the frontier
        endCursor = r.cursor;
        break;
      }
      continue; // re-step after the fill
    }
    if (clampChapter !== null && r.cursor.chapter > clampChapter) break;
    if (toCursor !== null) {
      const cmp = compareCursors(r.cursor, toCursor);
      if (w.dir === 'f' && cmp > 0) break;
      if (w.dir === 'b' && cmp <= 0) break;
    }
    cursor = r.cursor;
    windowRows.push({ row: r.row, cursor: r.cursor });
  }

  const chunk: Record<string, unknown>[] = [];
  let hitCreate = false;
  for (const { row: idx } of windowRows) {
    const pdu = await pduById(room.dbName, idx.commit_hash, idx.event_id);
    if (!pdu) continue;
    if (pdu.type === 'm.room.create') hitCreate = true;
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
        stateCommitHash: idx.state_commit_hash,
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
    start: w.fromToken ?? '',
  };
  if (hitCreate) {
    // the walk's end — no more events → no end (§3.10)
  } else if (endCursor !== null) {
    // the frontier cursor, so the client comes back for more
    result.end = formatCursorToken(endCursor);
  } else if (windowRows.length > 0) {
    // the raw page is non-empty: end continues past the last raw row —
    // the walk's current cursor IS the resume position (the next step
    // from it moves past the last returned event on either parity)
    result.end = formatCursorToken(cursor);
  }

  if (w.lazyLoadMembers) {
    const senders = new Set(chunk.map((e) => String(e.sender)));
    const endRow = w.dir === 'f'
      ? (windowRows.length > 0 ? windowRows[windowRows.length - 1].row : null)
      : (windowRows.length > 0 ? windowRows[0].row : null);
    const memberRows = endRow !== null && endRow.seq !== null
      ? ((await stateAtSeq(w.roomId, endRow.seq)) ?? []).filter((r) =>
        r.type === 'm.room.member' && senders.has(r.stateKey)
      )
      : [];
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
