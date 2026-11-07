// Durable presence and receipt streams, shared by client writes and inbound EDUs.
// Counters and rows commit together; notifications only follow a commit.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import { eventStreamTx } from '#engine/server/stream.ts';
import { isJoined } from '#engine/server/read.ts';

export type PresenceRow = {
  presence: string;
  statusMsg: string | null;
  lastActiveMs: number;
  seq: number;
};
export type ReceiptRow = {
  userId: string;
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
  if (!['online', 'offline', 'unavailable'].includes(presence)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad presence: ' + presence);
  }
  const lastActiveMs = Date.now() - (opts.lastActiveAgo ?? 0);
  const row = await eventStreamTx(server, async (tx) => {
    const seq = await next(tx, 'presence');
    await tx.execute(
      `INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET presence=excluded.presence,status_msg=excluded.status_msg,last_active_ms=excluded.last_active_ms,seq=excluded.seq`,
      [userId, presence, statusMsg ?? null, lastActiveMs, seq],
    );
    return { presence, statusMsg: statusMsg ?? null, lastActiveMs, seq };
  });
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
  opts: { ts?: number; threadId?: string | null } = {},
): Promise<boolean> {
  const ts = opts.ts ?? Date.now();
  const row = await eventStreamTx(server, async (tx) => {
    if (!await isJoined(tx, roomId, userId)) return null;
    const seq = await next(tx, 'receipts');
    await tx.execute(
      `INSERT INTO receipts(room_id,user_id,receipt_type,event_id,ts_ms,seq) VALUES(?,?,?,?,?,?)
      ON CONFLICT(room_id,user_id,receipt_type) DO UPDATE SET event_id=excluded.event_id,ts_ms=excluded.ts_ms,seq=excluded.seq`,
      [roomId, userId, receiptType, eventId, ts, seq],
    );
    return { userId, eventId, ts, seq };
  });
  if (row === null) return false;
  // doltgres stored no per-thread receipt; private rows never federate.
  notify(server, { kind: 'receipt', roomId, receiptType, row });
  return true;
}
export async function receiptRows(
  server: Db,
  roomId: string,
  since = 0,
): Promise<ReceiptRow[]> {
  const rows = await server.query(
    "SELECT * FROM receipts WHERE room_id=? AND receipt_type='m.read' AND seq>? ORDER BY seq",
    [roomId, since],
  );
  return rows.map((r) => ({
    userId: String(r.user_id),
    eventId: String(r.event_id),
    ts: Number(r.ts_ms),
    seq: Number(r.seq),
  }));
}
export async function receiptsSince(
  server: Db,
  roomId: string,
  since: number,
): Promise<Record<string, unknown> | null> {
  const rows = await receiptRows(server, roomId, since);
  if (!rows.length) return null;
  const content: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const row of rows) {
    content[row.eventId] ??= {};
    content[row.eventId]['m.read'] ??= {};
    content[row.eventId]['m.read'][row.userId] = { ts: row.ts };
  }
  return content;
}
