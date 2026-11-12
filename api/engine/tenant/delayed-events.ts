// Durable commands and signed submission receipts. All effects use one tenant
// connection; room authorization and writes are composed outside this module.
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import type { Pdu } from '#engine/pdu.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { DeviceIdentity } from './devices.ts';
import type { PreparedSubmission } from '#engine/room/ingest.ts';

export type DelayedEvent = {
  id: string;
  localpart: string;
  roomId: string;
  type: string;
  stateKey: string | null;
  content: Record<string, unknown>;
  delay: number;
  since: number;
  due: number;
  roomPos: number;
  stateEvent: string | null;
  phase: string;
};
export type DelayReceipt = {
  device: DeviceIdentity;
  endpoint: string;
  txnId: string;
};

function eventOf(r: Row): DelayedEvent {
  return {
    id: String(r.id),
    localpart: String(r.localpart),
    roomId: String(r.room_id),
    type: String(r.type),
    stateKey: r.state_key === null ? null : String(r.state_key),
    content: JSON.parse(String(r.content)),
    delay: Number(r.delay_ms),
    since: Number(r.since_ms),
    due: Number(r.due_ms),
    roomPos: Number(r.room_pos),
    stateEvent: r.state_event === null ? null : String(r.state_event),
    phase: String(r.phase),
  };
}
export function notFound(): never {
  throw new MatrixError(404, 'M_NOT_FOUND', 'no matching delayed event');
}
export async function get(
  conn: Conn,
  id: string,
): Promise<DelayedEvent | null> {
  const rows = await conn.query('SELECT * FROM delayed_events WHERE id=?', [
    id,
  ]);
  return rows.length ? eventOf(rows[0]) : null;
}
export async function list(
  conn: Conn,
  localpart: string,
): Promise<DelayedEvent[]> {
  return (await conn.query(
    'SELECT * FROM delayed_events WHERE localpart=? ORDER BY due_ms,id',
    [localpart],
  )).map(eventOf);
}
export async function receipt(
  conn: Conn,
  r: DelayReceipt,
): Promise<string | null> {
  const d = r.device;
  const rows = await conn.query(
    'SELECT delay_id FROM delayed_event_receipts WHERE localpart=? AND device_id=? AND generation=? AND endpoint=? AND txn_id=?',
    [d.localpart, d.deviceId, d.generation, r.endpoint, r.txnId],
  );
  return rows.length ? String(rows[0].delay_id) : null;
}
export async function add(
  conn: Conn,
  event: DelayedEvent,
  limit: number,
  r?: DelayReceipt,
): Promise<string> {
  if (r) {
    const existing = await receipt(conn, r);
    if (existing !== null) return existing;
  }
  const account = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [event.localpart],
  );
  if (!account.length || account[0].deactivated !== 0) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'account inactive');
  }
  const count = await conn.query(
    'SELECT COUNT(*) AS n FROM delayed_events WHERE localpart=?',
    [event.localpart],
  );
  if (Number(count[0].n) >= limit) {
    throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'too many delayed events');
  }
  await conn.execute(
    'INSERT INTO delayed_events(id,localpart,room_id,type,state_key,content,delay_ms,since_ms,due_ms,room_pos,state_event) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [
      event.id,
      event.localpart,
      event.roomId,
      event.type,
      event.stateKey,
      canonicalJson(event.content),
      event.delay,
      event.since,
      event.due,
      event.roomPos,
      event.stateEvent,
    ],
  );
  if (r) {
    const d = r.device;
    await conn.execute(
      'INSERT INTO delayed_event_receipts(localpart,device_id,generation,endpoint,txn_id,delay_id) VALUES(?,?,?,?,?,?)',
      [d.localpart, d.deviceId, d.generation, r.endpoint, r.txnId, event.id],
    );
  }
  return event.id;
}
export async function remove(conn: Conn, id: string): Promise<void> {
  await conn.execute('DELETE FROM delayed_events WHERE id=?', [id]);
}
export async function action(
  conn: Conn,
  id: string,
  action: 'cancel' | 'restart' | 'send',
  now: number,
): Promise<void> {
  const event = await get(conn, id);
  if (event === null || event.phase !== 'pending') notFound();
  if (action === 'cancel') return await remove(conn, id);
  await conn.execute(
    "UPDATE delayed_events SET since_ms=?,due_ms=? WHERE id=? AND phase='pending'",
    [
      action === 'restart' ? now : event.since,
      action === 'restart' ? now + event.delay : now,
      id,
    ],
  );
}
export async function next(conn: Conn): Promise<number | null> {
  const rows = await conn.query('SELECT MIN(due_ms) AS n FROM delayed_events');
  return rows[0].n === null ? null : Number(rows[0].n);
}
export async function due(conn: Conn, now: number): Promise<DelayedEvent[]> {
  return (await conn.query(
    'SELECT * FROM delayed_events WHERE due_ms<=? ORDER BY due_ms,id LIMIT 32',
    [now],
  )).map(eventOf);
}
export async function claim(
  conn: Conn,
  id: string,
  now: number,
): Promise<DelayedEvent | null> {
  const event = await get(conn, id);
  // Selection is only a hint. A concurrent heartbeat may have restarted the
  // deadline before this transaction acquired the command.
  if (event === null || event.due > now) return null;
  await conn.execute("UPDATE delayed_events SET phase='sending' WHERE id=?", [
    id,
  ]);
  return event;
}
export async function submission(
  conn: Conn,
  id: string,
): Promise<PreparedSubmission | null> {
  const rows = await conn.query(
    'SELECT event_id,pending_pdu FROM delayed_events WHERE id=?',
    [id],
  );
  if (!rows.length || rows[0].event_id === null) return null;
  return {
    eventId: String(rows[0].event_id),
    pdu: rows[0].pending_pdu === null
      ? null
      : JSON.parse(String(rows[0].pending_pdu)),
  };
}
export async function prepare(
  conn: Conn,
  id: string,
  pdu: Pdu,
): Promise<PreparedSubmission> {
  await conn.execute(
    'UPDATE delayed_events SET event_id=?,pending_pdu=? WHERE id=? AND event_id IS NULL',
    [String(pdu.event_id), canonicalJson(pdu), id],
  );
  const result = await submission(conn, id);
  if (result === null) throw new Error('E_DELAYED_SUBMISSION_MISSING');
  return result;
}
export async function finish(conn: Conn, id: string): Promise<void> {
  await conn.execute(
    'UPDATE delayed_events SET completed=1,pending_pdu=NULL WHERE id=?',
    [id],
  );
}
