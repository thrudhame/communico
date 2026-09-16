// api/engine/event-format.ts — the ONE client-event formatter (plan §2).
// unsigned.transaction_id (commit 7), redaction at read (commit 8) and
// unsigned.membership (commit 12) land in their commits; the shape and
// the single-entry-point discipline are M4-commit-5.
import type { Pdu } from './pdu.ts';

// The event_index row shape the formatter needs (mirrors the M4 columns).
export interface EventIndexRow {
  event_id: string;
  room_id: string;
  commit_hash: string;
  rejected: boolean;
  soft_failed: boolean;
  seq: number;
  state_commit_hash: string | null;
  redacted_by: string | null;
  txn_device: string | null;
  txn_id: string | null;
}

// The client-visible event: event_id, type, sender, content,
// origin_server_ts, room_id, state_key? and unsigned{age,
// transaction_id?}. unsigned.transaction_id renders only when the viewer
// IS the sending device (Complement TestTxnScopeOnLocalEcho). The stored
// PDU stays verbatim — anything derived lives here, never in the DAG.
export function clientEvent(
  pdu: Pdu,
  row: EventIndexRow,
  viewer?: { userId: string; deviceId: string | null },
): Record<string, unknown> {
  const ev: Record<string, unknown> = {
    event_id: row.event_id,
    type: pdu.type,
    sender: pdu.sender,
    content: pdu.content ?? {},
    origin_server_ts: pdu.origin_server_ts,
    room_id: row.room_id,
  };
  if (pdu.state_key != null) ev.state_key = pdu.state_key;
  const unsigned: Record<string, unknown> = {
    age: Math.max(0, Date.now() - Number(pdu.origin_server_ts)),
  };
  if (
    viewer?.deviceId != null && row.txn_device === viewer.deviceId &&
    row.txn_id != null
  ) {
    unsigned.transaction_id = row.txn_id;
  }
  ev.unsigned = unsigned;
  return ev;
}
