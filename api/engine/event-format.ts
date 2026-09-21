// api/engine/event-format.ts — the ONE client-event formatter (plan §2).
// unsigned.transaction_id (commit 7), redaction at read (commit 8) and
// unsigned.membership (commit 12) land in their commits; the shape and
// the single-entry-point discipline are M4-commit-5.
import { redact } from './eventid.ts';
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

// Map a raw event_index DB row to the formatter's shape.
// deno-lint-ignore no-explicit-any
export function eventIndexRowOf(row: any): EventIndexRow {
  return {
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
  };
}

// The client-visible event: event_id, type, sender, content,
// origin_server_ts, room_id, state_key? and unsigned{age,
// transaction_id?, redacted_because?}. unsigned.transaction_id renders
// only when the viewer IS the sending device (Complement
// TestTxnScopeOnLocalEcho). A redacted event renders through the room
// version's keep-table (eventid.ts redact()) — content {} for a redacted
// m.room.message — with the redaction event copied into
// unsigned.redacted_because (spec _index.md "Redactions" at v1.16). The
// stored PDU stays verbatim — anything derived lives here, never in the
// DAG.
// Band C (D7): the bundled thread aggregation for a thread root
// (threading.md:142-201) — assembled into unsigned.m.relations.m.thread
// by clientEvent when the caller passes it (the data comes from the
// relations index; the render is one level deep).
export interface ThreadBundle {
  latest_event: Record<string, unknown>;
  count: number;
  current_user_participated: boolean;
}

export function clientEvent(
  pdu: Pdu,
  row: EventIndexRow,
  viewer?: { userId: string; deviceId: string | null; membership?: string },
  redaction?: { roomVersion: string; event: Record<string, unknown> },
  thread?: ThreadBundle,
  opts?: { omitRoomId?: boolean },
): Record<string, unknown> {
  const redacted = row.redacted_by != null && redaction !== undefined;
  const shown = redacted
    ? (redact(
      pdu as unknown as Record<string, unknown>,
      redaction!.roomVersion,
    ) as unknown as Pdu)
    : pdu;
  const ev: Record<string, unknown> = {
    event_id: row.event_id,
    type: shown.type,
    sender: shown.sender,
    content: shown.content ?? {},
    origin_server_ts: shown.origin_server_ts,
  };
  // room_id comes from the index row (D2 — a v12 create's stored PDU has
  // none; client_event.yaml:24,48 requires it everywhere EXCEPT /sync,
  // whose ClientEventWithoutRoomID variant strips it)
  if (opts?.omitRoomId !== true) ev.room_id = row.room_id;
  if (shown.state_key != null) ev.state_key = shown.state_key;
  const unsigned: Record<string, unknown> = {
    age: Math.max(0, Date.now() - Number(pdu.origin_server_ts)),
  };
  if (
    viewer?.deviceId != null && row.txn_device === viewer.deviceId &&
    row.txn_id != null
  ) {
    unsigned.transaction_id = row.txn_id;
  }
  // MSC4115: the viewer's membership at the event (the caller computes it
  // per event — E1 state-at-seq; 'leave' when the viewer has no member
  // row there).
  if (viewer?.membership !== undefined) {
    unsigned.membership = viewer.membership;
  }
  if (redacted) unsigned.redacted_because = redaction!.event;
  if (thread !== undefined) {
    unsigned['m.relations'] = { 'm.thread': thread };
  }
  ev.unsigned = unsigned;
  return ev;
}
