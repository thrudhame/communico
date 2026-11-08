// api/engine/tenant/txns.ts — client transaction ids (M4): idempotency
// scoped to (device, room, txn) — a repeat send returns the recorded
// event_id regardless of content (Complement txnid_test.go).
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function transactionById(
  conn: Conn,
  deviceId: string,
  roomId: string,
  txnId: string,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT event_id FROM transactions WHERE device_id = ? AND room_id = ? AND txn_id = ?',
    [deviceId, roomId, txnId],
  );
  return rows.length === 0 ? null : String(rows[0].event_id);
}

export async function insertTransaction(
  conn: Conn,
  deviceId: string,
  roomId: string,
  txnId: string,
  eventId: string,
): Promise<void> {
  await conn.execute(
    `INSERT INTO transactions (device_id, room_id, txn_id, event_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (device_id, room_id, txn_id) DO NOTHING`,
    [deviceId, roomId, txnId, eventId],
  );
}

// --- tenant-level behaviour --------------------------------------------------

/** The recorded event_id for a (device, room, txn), or null. */
export async function lookupTransaction(
  tenant: Tenant,
  deviceId: string,
  roomId: string,
  txnId: string,
): Promise<string | null> {
  return await tenant.tx((tx) => tx.txns.lookup(deviceId, roomId, txnId));
}

/** Record a (device, room, txn) -> event_id after a successful send. */
export async function recordTransaction(
  tenant: Tenant,
  deviceId: string,
  roomId: string,
  txnId: string,
  eventId: string,
): Promise<void> {
  await tenant.tx((tx) => tx.txns.record(deviceId, roomId, txnId, eventId));
}
