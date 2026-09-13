// api/engine/pdu.ts — the v11 Persistent Data Unit shape (F0).
// Event PDU shape shared by every consumer. event_id is DERIVED
// (eventIdFor over the redacted PDU) and never inside the hashed body.
export interface Pdu {
  type: string;
  room_id: string;
  sender: string;
  content: Record<string, unknown>;
  state_key?: string;
  prev_events: string[];
  auth_events: string[];
  depth: number;
  origin_server_ts: number;
  hashes: { sha256: string };
  signatures: Record<string, Record<string, string>>;
  unsigned?: Record<string, unknown>;
  event_id?: string;
}
