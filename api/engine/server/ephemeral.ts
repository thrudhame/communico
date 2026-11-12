// Durable presence and receipt streams, shared by client writes and inbound EDUs.
// Counters and rows commit together; notifications only follow a commit.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import { eventStreamTx } from '#engine/server/stream.ts';
import { isJoined, receiptTargetInThread } from '#engine/server/read.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';

const MAX_UNKNOWN_THREADS = 100;
/** Protocol identifiers, not arbitrary durable keys. Adapters must not coerce
 * malformed metadata into the distinct unthreaded identity. */
export function receiptThreadId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    (value !== 'main' && !/^\$\S+$/.test(value)) ||
    new TextEncoder().encode(value).length > 255
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid receipt thread_id');
  }
  return value;
}

export type PresenceRow = {
  presence: string;
  statusMsg: string | null;
  lastActiveMs: number;
  seq: number;
};
export type ReceiptRow = {
  userId: string;
  receiptType: 'm.read' | 'm.read.private';
  threadId: string | null;
  eventId: string;
  ts: number;
  seq: number;
};
export type EphemeralChange =
  | { kind: 'presence'; userId: string; row: PresenceRow }
  | {
    kind: 'receipt';
    roomId: string;
    receiptType: 'm.read' | 'm.read.private';
    row: ReceiptRow;
  };
const listeners = new Set<(server: Db, change: EphemeralChange) => void>();
export function onEphemeral(
  fn: (server: Db, change: EphemeralChange) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function notify(server: Db, change: EphemeralChange): void {
  for (const fn of listeners) {
    try {
      fn(server, change);
    } catch (error) {
      console.error('ephemeral listener error:', error);
    }
  }
}
async function next(tx: Conn, name: string): Promise<number> {
  await tx.execute(
    'INSERT INTO counters(name,value) VALUES(?,0) ON CONFLICT(name) DO NOTHING',
    [name],
  );
  await tx.execute('UPDATE counters SET value=value+1 WHERE name=?', [name]);
  return Number(
    (await tx.query('SELECT value FROM counters WHERE name=?', [name]))[0]
      .value,
  );
}
export async function streamMax(
  server: Db,
  name: 'presence' | 'receipts',
): Promise<number> {
  const rows = await server.query('SELECT value FROM counters WHERE name=?', [
    name,
  ]);
  return rows.length ? Number(rows[0].value) : 0;
}
export async function setPresence(
  server: Db,
  userId: string,
  presence: string,
  statusMsg?: string,
  opts: { lastActiveAgo?: number; currentlyActive?: boolean } = {},
): Promise<void> {
  await writePresence(server, userId, presence, statusMsg ?? null, opts, false);
}

// A presence-only intent preserves the separately owned status message and
// does nothing when the value already matches, including concurrent callers.
export async function setPresenceValue(
  server: Db,
  userId: string,
  presence: string,
): Promise<void> {
  await writePresence(server, userId, presence, undefined, {}, true);
}

async function writePresence(
  server: Db,
  userId: string,
  presence: string,
  statusMsg: string | null | undefined,
  opts: { lastActiveAgo?: number; currentlyActive?: boolean },
  skipUnchanged: boolean,
): Promise<void> {
  if (!['online', 'offline', 'unavailable'].includes(presence)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad presence: ' + presence);
  }
  const lastActiveMs = Date.now() - (opts.lastActiveAgo ?? 0);
  const row = await eventStreamTx(server, async (tx) => {
    let status = statusMsg;
    if (skipUnchanged) {
      const current = (await tx.query(
        'SELECT presence,status_msg FROM presence WHERE user_id=?',
        [userId],
      ))[0];
      if (current?.presence === presence) return null;
      status = current?.status_msg == null ? null : String(current.status_msg);
    }
    const seq = await next(tx, 'presence');
    await tx.execute(
      `INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET presence=excluded.presence,status_msg=excluded.status_msg,last_active_ms=excluded.last_active_ms,seq=excluded.seq`,
      [userId, presence, status ?? null, lastActiveMs, seq],
    );
    return { presence, statusMsg: status ?? null, lastActiveMs, seq };
  });
  if (row === null) return;
  notify(server, { kind: 'presence', userId, row });
}
export async function ensurePresenceRow(
  server: Db,
  userId: string,
): Promise<void> {
  await eventStreamTx(server, async (tx) => {
    if (
      (await tx.query('SELECT 1 FROM presence WHERE user_id=?', [userId]))
        .length
    ) return;
    const seq = await next(tx, 'presence');
    await tx.execute(
      "INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq) VALUES(?,'offline',NULL,?,?)",
      [userId, Date.now(), seq],
    );
  });
}
export async function getPresence(
  server: Db,
  userId: string,
): Promise<PresenceRow> {
  const rows = await server.query('SELECT * FROM presence WHERE user_id=?', [
    userId,
  ]);
  const r = rows[0];
  return r === undefined
    ? { presence: 'offline', statusMsg: null, lastActiveMs: 0, seq: 0 }
    : {
      presence: String(r.presence),
      statusMsg: r.status_msg == null ? null : String(r.status_msg),
      lastActiveMs: Number(r.last_active_ms),
      seq: Number(r.seq),
    };
}
export async function sharedUsers(
  server: Db,
  userId: string,
): Promise<string[]> {
  const rows = await server.query(
    `SELECT DISTINCT b.user FROM memberships a JOIN memberships b ON a.room=b.room
    WHERE a.user=? AND a.membership='join' AND b.membership='join' ORDER BY b.user`,
    [userId],
  );
  return rows.map((r) => String(r.user));
}
export async function setReceipt(
  server: Db,
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  eventId: string,
  opts: { ts?: number; threadId?: string | null; requireRelated?: boolean } =
    {},
): Promise<boolean> {
  const ts = opts.ts ?? Date.now();
  const threadId = receiptThreadId(opts.threadId);
  const row = await eventStreamTx(server, async (tx) => {
    if (!await isJoined(tx, roomId, userId)) return null;
    if (threadId !== null && threadId !== 'main') {
      const existing = await tx.query(
        'SELECT 1 FROM receipts WHERE room_id=? AND user_id=? AND receipt_type=? AND thread_id=?',
        [roomId, userId, receiptType, threadId],
      );
      const known = await tx.query(
        'SELECT 1 FROM event_index WHERE room=? AND event=?',
        [roomId, threadId],
      );
      if (!existing.length && !known.length) {
        const pending = await tx.query(
          `SELECT 1 FROM receipts r WHERE room_id=? AND user_id=? AND receipt_type=?
          AND thread_id NOT IN ('','main') AND NOT EXISTS (
            SELECT 1 FROM event_index e WHERE e.room=r.room_id AND e.event=r.thread_id
          ) LIMIT ?`,
          [roomId, userId, receiptType, MAX_UNKNOWN_THREADS],
        );
        if (pending.length >= MAX_UNKNOWN_THREADS) {
          throw new MatrixError(
            429,
            'M_LIMIT_EXCEEDED',
            'unknown receipt thread capacity reached',
          );
        }
      }
    }
    // Local API admission and read effects share the same relation snapshot.
    // Inbound EDUs may reference targets not held yet and retain their identity.
    if (
      opts.requireRelated && threadId !== null &&
      !await receiptTargetInThread(tx, roomId, eventId, threadId)
    ) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'event_id is not related to the given thread',
      );
    }
    const seq = await next(tx, 'receipts');
    await tx.execute(
      `INSERT INTO receipts(room_id,user_id,receipt_type,thread_id,event_id,ts_ms,seq) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(room_id,user_id,receipt_type,thread_id) DO UPDATE SET event_id=excluded.event_id,ts_ms=excluded.ts_ms,seq=excluded.seq`,
      [roomId, userId, receiptType, threadId ?? '', eventId, ts, seq],
    );
    const admitted = await advanceNotificationRead(
      tx,
      userId,
      roomId,
      threadId ?? '',
      eventId,
      Date.now(),
    );
    if (!admitted) {
      throw new MatrixError(
        429,
        'M_LIMIT_EXCEEDED',
        'pending receipt capacity reached',
      );
    }
    return { userId, receiptType, threadId, eventId, ts, seq };
  });
  if (row === null) return false;
  // Private rows wake their owner, but federation only consumes public rows.
  notify(server, { kind: 'receipt', roomId, receiptType, row });
  return true;
}
// Relevance is a publication read too: use the same public-or-own contract for
// long-poll wakeups and incremental room selection as for receipt content.
export async function receiptRoomsSince(
  server: Db,
  userId: string,
  since: number,
): Promise<Set<string>> {
  const rows = await server.query(
    `SELECT DISTINCT room_id FROM receipts WHERE room_id IN (
      SELECT room FROM memberships WHERE user=? AND membership='join'
    ) AND seq>? AND ${VISIBLE_RECEIPTS}`,
    [userId, since, userId],
  );
  return new Set(rows.map((r) => String(r.room_id)));
}

export async function receiptRows(
  server: Pick<Db, 'query'>,
  roomId: string,
  since = 0,
  viewer: string | null = null,
  until = Number.MAX_SAFE_INTEGER,
): Promise<ReceiptRow[]> {
  const rows = await server.query(
    `SELECT * FROM receipts WHERE room_id=? AND seq>? AND seq<=? AND ${VISIBLE_RECEIPTS} ORDER BY seq`,
    [roomId, since, until, viewer],
  );
  return rows.map((r) => ({
    userId: String(r.user_id),
    receiptType: String(r.receipt_type) as ReceiptRow['receiptType'],
    threadId: r.thread_id === '' ? null : String(r.thread_id),
    eventId: String(r.event_id),
    ts: Number(r.ts_ms),
    seq: Number(r.seq),
  }));
}
export async function receiptsSince(
  server: Pick<Db, 'query'>,
  roomId: string,
  viewer: string,
  since: number,
): Promise<Record<string, unknown>[]> {
  const rows = await receiptRows(server, roomId, since, viewer);
  return receiptContents(rows);
}

/** One set-based capture for all the viewer's membership rooms. The caller
 * supplies the same transaction that owns membership, counts and maxima. */
export async function receiptSnapshot(
  server: Pick<Db, 'query'>,
  viewer: string,
  since: number,
): Promise<Map<string, Record<string, unknown>[]>> {
  const rows = await server.query(
    `SELECT r.* FROM receipts r WHERE seq>? AND ${VISIBLE_RECEIPTS}
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.room=r.room_id AND m.user=?) ORDER BY seq`,
    [since, viewer, viewer],
  );
  const rooms = new Map<string, ReceiptRow[]>();
  for (const r of rows) {
    const room = String(r.room_id);
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room)!.push({
      userId: String(r.user_id),
      receiptType: String(r.receipt_type) as ReceiptRow['receiptType'],
      threadId: r.thread_id === '' ? null : String(r.thread_id),
      eventId: String(r.event_id),
      ts: Number(r.ts_ms),
      seq: Number(r.seq),
    });
  }
  return new Map([...rooms].map(([id, marks]) => [id, receiptContents(marks)]));
}

type ReceiptContent = Record<string, Record<string, Record<string, unknown>>>;

function putReceipt(content: ReceiptContent, row: ReceiptRow): void {
  content[row.eventId] ??= {};
  content[row.eventId][row.receiptType] ??= {};
  content[row.eventId][row.receiptType][row.userId] = {
    ts: row.ts,
    ...(row.threadId === null ? {} : { thread_id: row.threadId }),
  };
}

/** Single-event MSC4102 wire map: unthreaded wins a colliding slot, while
 * representable threaded slots retain their identity. Durable rows stay intact;
 * ordinary sync can still emit all slots as separate per-thread events. */
export function receiptContent(rows: ReceiptRow[]): ReceiptContent {
  const content: ReceiptContent = {};
  for (const row of rows) {
    const previous = content[row.eventId]?.[row.receiptType]?.[row.userId] as {
      thread_id?: string;
    } | undefined;
    if (row.threadId !== null && previous && previous.thread_id === undefined) {
      continue;
    }
    putReceipt(content, row);
  }
  return content;
}

function receiptContents(rows: ReceiptRow[]): Record<string, unknown>[] {
  // Batch separately by thread: the wire map cannot hold both an unthreaded
  // and a main receipt at the same event/type/user key in one event.
  const threads = new Map<string | null, ReceiptContent>();
  for (const row of rows) {
    let content = threads.get(row.threadId);
    if (content === undefined) {
      content = {};
      threads.set(row.threadId, content);
    }
    putReceipt(content, row);
  }
  return [...threads.values()];
}

// One visibility predicate for payloads and long-poll relevance. The default
// null viewer in receiptRows is the public-only federation reader.
const VISIBLE_RECEIPTS =
  "(receipt_type='m.read' OR (receipt_type='m.read.private' AND user_id=?))";
