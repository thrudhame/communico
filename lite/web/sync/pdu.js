// sync/pdu.js — browser mirror of api/engine/pdu.ts (same fields).
// event_id is derived, never inside the hashed body.

// Minimal structural check for an inbound PDU (F0): required hashed
// fields present with the right containers; bounds checked at ingest
// (<=20 prev_events, <=10 auth_events, depth recomputed).
export function isPduShape(pdu) {
  if (!pdu || typeof pdu !== 'object') return false;
  return typeof pdu.type === 'string' &&
    typeof pdu.room_id === 'string' &&
    typeof pdu.sender === 'string' &&
    pdu.content !== null && typeof pdu.content === 'object' &&
    Array.isArray(pdu.prev_events) &&
    Array.isArray(pdu.auth_events) &&
    typeof pdu.depth === 'number' &&
    typeof pdu.origin_server_ts === 'number' &&
    pdu.hashes !== null && typeof pdu.hashes === 'object' &&
    typeof pdu.hashes.sha256 === 'string' &&
    pdu.signatures !== null && typeof pdu.signatures === 'object';
}
