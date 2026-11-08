// api/engine/tenant/txns.ts — client transaction ids (M4): idempotency
// scoped to (device, endpoint, txn) - a repeat send returns the recorded
// event_id regardless of content (Complement txnid_test.go).
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import type {
  LocalSubmission,
  PreparedSubmission,
} from '#engine/room/ingest.ts';
import { canonicalJson } from '#engine/canonical.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { deviceById } from '#engine/tenant/devices.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export async function deviceIdentity(
  tenant: Tenant,
  localpart: string,
  deviceId: string,
  generation?: number,
): Promise<DeviceIdentity> {
  const row = await tenant.tx((tx) => tx.devices.byId(deviceId, localpart));
  if (
    row === null || (generation !== undefined && row.generation !== generation)
  ) throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'device no longer exists');
  return { localpart, deviceId, generation: row.generation };
}

function scope(device: DeviceIdentity): [string, string, number] {
  return [device.localpart, device.deviceId, device.generation];
}

async function requireCurrent(
  conn: Conn,
  device: DeviceIdentity,
): Promise<void> {
  const row = await deviceById(conn, device.deviceId, device.localpart);
  if (row === null || row.generation !== device.generation) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'device no longer exists');
  }
}

export type TransactionEndpoint =
  | { kind: 'send'; roomId: string; eventType: string }
  | { kind: 'redact'; roomId: string; eventId: string };

function endpointKey(endpoint: TransactionEndpoint): string {
  return JSON.stringify([
    endpoint.kind,
    endpoint.roomId,
    endpoint.kind === 'send' ? endpoint.eventType : endpoint.eventId,
  ]);
}

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function transactionById(
  conn: Conn,
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT event_id FROM transactions WHERE localpart = ? AND device_id = ? AND generation = ? AND endpoint = ? AND txn_id = ? AND completed = 1',
    [...scope(device), endpointKey(endpoint), txnId],
  );
  return rows.length === 0 ? null : String(rows[0].event_id);
}

export async function insertTransaction(
  conn: Conn,
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
  eventId: string,
): Promise<void> {
  await requireCurrent(conn, device);
  await conn.execute(
    `INSERT INTO transactions (localpart, device_id, generation, endpoint, room_id, txn_id, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (localpart, device_id, generation, endpoint, txn_id) DO NOTHING`,
    [...scope(device), endpointKey(endpoint), endpoint.roomId, txnId, eventId],
  );
}

// --- tenant-level behaviour --------------------------------------------------

/** The recorded event_id for a (device, endpoint, txn), or null. */
export async function lookupTransaction(
  tenant: Tenant,
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
): Promise<string | null> {
  return await tenant.tx((tx) => tx.txns.lookup(device, endpoint, txnId));
}

/** Record a (device, endpoint, txn) -> event_id after a successful send. */
export async function recordTransaction(
  tenant: Tenant,
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
  eventId: string,
): Promise<void> {
  await tenant.tx((tx) => tx.txns.record(device, endpoint, txnId, eventId));
}

/** The sending device's local echo metadata, resolved from durable receipts. */
export async function transactionForEvent(
  tenant: Tenant,
  device: DeviceIdentity,
  roomId: string,
  eventId: string,
): Promise<string | null> {
  return await tenant.tx((tx) => tx.txns.forEvent(device, roomId, eventId));
}

export async function transactionIdForEvent(
  conn: Conn,
  device: DeviceIdentity,
  roomId: string,
  eventId: string,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT txn_id FROM transactions WHERE localpart = ? AND device_id = ? AND generation = ? AND room_id = ? AND event_id = ? AND completed = 1 ORDER BY txn_id LIMIT 1',
    [...scope(device), roomId, eventId],
  );
  return rows.length === 0 ? null : String(rows[0].txn_id);
}

export async function submissionById(
  conn: Conn,
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
): Promise<PreparedSubmission | null> {
  const rows = await conn.query(
    'SELECT event_id, pending_pdu FROM transactions WHERE localpart = ? AND device_id = ? AND generation = ? AND endpoint = ? AND txn_id = ?',
    [...scope(device), endpointKey(endpoint), txnId],
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
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
  pdu: Pdu,
): Promise<PreparedSubmission> {
  await requireCurrent(conn, device);
  await conn.execute(
    `INSERT INTO transactions(localpart, device_id, generation, endpoint, room_id, txn_id, event_id, pending_pdu, completed)
     VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(localpart, device_id, generation, endpoint, txn_id) DO NOTHING`,
    [
      ...scope(device),
      endpointKey(endpoint),
      endpoint.roomId,
      txnId,
      String(pdu.event_id),
      canonicalJson(pdu),
    ],
  );
  const row = await submissionById(conn, device, endpoint, txnId);
  if (row === null) throw new Error('E_SUBMISSION_MISSING');
  return row;
}

export async function finishSubmission(
  conn: Conn,
  device: DeviceIdentity,
  endpoint: TransactionEndpoint,
  txnId: string,
  eventId: string,
  accepted: boolean,
): Promise<void> {
  const key = [...scope(device), endpointKey(endpoint), txnId, eventId];
  if (accepted) {
    await conn.execute(
      'UPDATE transactions SET completed = 1, pending_pdu = NULL WHERE localpart = ? AND device_id = ? AND generation = ? AND endpoint = ? AND txn_id = ? AND event_id = ?',
      key,
    );
  } else {
    await conn.execute(
      'DELETE FROM transactions WHERE localpart = ? AND device_id = ? AND generation = ? AND endpoint = ? AND txn_id = ? AND event_id = ? AND completed = 0',
      key,
    );
  }
}

// The room owns serialization; the tenant owns the durable command and receipt.
// No tenant transaction encloses a room mutation or survives a callback.
export function transactionSubmission(
  tenant: Tenant,
  device: DeviceIdentity | null,
  endpoint: TransactionEndpoint,
  txnId: string,
): LocalSubmission | undefined {
  if (device === null) return undefined;
  return {
    lookup: () =>
      tenant.tx((tx) => tx.txns.submission(device, endpoint, txnId)),
    prepare: (pdu) =>
      tenant.tx((tx) => tx.txns.prepare(device, endpoint, txnId, pdu)),
    finish: (eventId, accepted) =>
      tenant.tx((tx) =>
        tx.txns.finish(device, endpoint, txnId, eventId, accepted)
      ),
  };
}
