// api/engine/receipts.ts — band C item 3 (D1): persisted read receipts.
// One row per (room, user, receipt_type) — the "up to" marker
// (receipts.md:14-20); each write takes the next receipt_seq, so /sync
// can ask "new since the token's _r<n>". m.read.private is accepted and
// stored but NEVER broadcast (receipts.md:114-115; plan §2), so it is
// simply never read back out.
import { serverDb, withDb } from './db.ts';

// POST /rooms/:id/receipt/m.read/:eventId — upsert the marker. ts_ms is
// server-set (receipts.yaml:83-84).
export async function setReceipt(
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  eventId: string,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO receipts (room_id, user_id, receipt_type, event_id, ts_ms, seq)
       VALUES ($1, $2, $3, $4, $5, nextval('receipt_seq'))
       ON CONFLICT (room_id, user_id, receipt_type)
       DO UPDATE SET event_id = EXCLUDED.event_id, ts_ms = EXCLUDED.ts_ms,
                     seq = nextval('receipt_seq');`,
      [roomId, userId, receiptType, eventId, Date.now()],
    );
  });
}

// The current stream position (next_batch's _r<n>).
export async function receiptSeq(): Promise<number> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query('SELECT MAX(seq) AS m FROM receipts;');
    return r.rows[0].m == null ? 0 : Number(r.rows[0].m);
  });
}

// The highest receipt seq in any room the user is joined to (the
// long-poll wake position — only rooms the syncer can see count; same
// subquery shape as syncfeed's relevantMaxes).
export async function receiptSeqForUser(userId: string): Promise<number> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT MAX(seq) AS m FROM receipts
       WHERE room_id IN (
         SELECT room_id FROM room_membership WHERE user_id = $1 AND membership = 'join'
       );`,
      [userId],
    );
    return r.rows[0].m == null ? 0 : Number(r.rows[0].m);
  });
}

// Receipts for a room since a stream position, as m.receipt event content
// ({ "<eventId>": { "m.read": { "<user>": { ts } } } }, receipts.md:34-38).
// m.read.private rows are never read out (see the header). null when
// nothing moved — the caller emits no event then.
export async function receiptsSince(
  roomId: string,
  rSeq: number,
): Promise<Record<string, unknown> | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT user_id, event_id, ts_ms FROM receipts
       WHERE room_id = $1 AND receipt_type = 'm.read' AND seq > $2
       ORDER BY seq ASC;`,
      [roomId, rSeq],
    );
    if (r.rows.length === 0) return null;
    const content: Record<string, Record<string, Record<string, unknown>>> = {};
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const eventId = String(row.event_id);
      content[eventId] ??= {};
      content[eventId]['m.read'] ??= {};
      content[eventId]['m.read'][String(row.user_id)] = {
        ts: Number(row.ts_ms),
      };
    }
    return content;
  });
}
