// api/engine/tenant/txns.ts — client transaction ids (M4): idempotency
// scoped to (device, room, txn) — a repeat send returns the recorded
// event_id regardless of content (Complement txnid_test.go).
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import type {
  LocalSubmission,
  PreparedSubmission,
} from '#engine/room/ingest.ts';
import { canonicalJson } from '#engine/canonical.ts';

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function transactionById(
  conn: Conn,
  deviceId: string,
  roomId: string,
  txnId: string,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT event_id FROM transactions WHERE device_id = ? AND room_id = ? AND txn_id = ? AND completed = 1',
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

/** The sending device's local echo metadata, resolved from durable receipts. */
export async function transactionForEvent(
  tenant: Tenant,
  deviceId: string,
  roomId: string,
  eventId: string,
): Promise<string | null> {
  return await tenant.tx((tx) => tx.txns.forEvent(deviceId, roomId, eventId));
}

export async function transactionIdForEvent(
  conn: Conn,
  deviceId: string,
  roomId: string,
  eventId: string,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT txn_id FROM transactions WHERE device_id = ? AND room_id = ? AND event_id = ? AND completed = 1 ORDER BY txn_id LIMIT 1',
    [deviceId, roomId, eventId],
  );
  return rows.length === 0 ? null : String(rows[0].txn_id);
}

export async function submissionById(
  conn: Conn,
  deviceId: string,
  roomId: string,
  txnId: string,
): Promise<PreparedSubmission | null> {
  const rows = await conn.query(
    'SELECT event_id, pending_pdu FROM transactions WHERE device_id = ? AND room_id = ? AND txn_id = ?',
    [deviceId, roomId, txnId],
  );
  if (rows.length === 0) return null;
  return {
    eventId: String(rows[0].event_id),
    pdu: rows[0].pending_pdu === null
      ? null
      : JSON.parse(String(rows[0].pending_pdu)) as Pdu,
  };
}

export async function prepareSubmission(
  conn: Conn,
  deviceId: string,
  roomId: string,
  txnId: string,
  pdu: Pdu,
): Promise<PreparedSubmission> {
  await conn.execute(
    `INSERT INTO transactions(device_id, room_id, txn_id, event_id, pending_pdu, completed)
     VALUES(?,?,?,?,?,0) ON CONFLICT(device_id, room_id, txn_id) DO NOTHING`,
    [deviceId, roomId, txnId, String(pdu.event_id), canonicalJson(pdu)],
  );
  const row = await submissionById(conn, deviceId, roomId, txnId);
  if (row === null) throw new Error('E_SUBMISSION_MISSING');
  return row;
}

export async function finishSubmission(
  conn: Conn,
  deviceId: string,
  roomId: string,
  txnId: string,
  eventId: string,
  accepted: boolean,
): Promise<void> {
  const key = [deviceId, roomId, txnId, eventId];
  if (accepted) {
    await conn.execute(
      'UPDATE transactions SET completed = 1, pending_pdu = NULL WHERE device_id = ? AND room_id = ? AND txn_id = ? AND event_id = ?',
      key,
    );
  } else {
    await conn.execute(
      'DELETE FROM transactions WHERE device_id = ? AND room_id = ? AND txn_id = ? AND event_id = ? AND completed = 0',
      key,
    );
  }
}

// The room owns serialization; the tenant owns the durable command and receipt.
// No tenant transaction encloses a room mutation or survives a callback.
export function transactionSubmission(
  tenant: Tenant,
  deviceId: string | null,
  roomId: string,
  txnId: string,
): LocalSubmission | undefined {
  if (deviceId === null) return undefined;
  return {
    lookup: () =>
      tenant.tx((tx) => tx.txns.submission(deviceId, roomId, txnId)),
    prepare: (pdu) =>
      tenant.tx((tx) => tx.txns.prepare(deviceId, roomId, txnId, pdu)),
    finish: (eventId, accepted) =>
      tenant.tx((tx) =>
        tx.txns.finish(deviceId, roomId, txnId, eventId, accepted)
      ),
  };
}
