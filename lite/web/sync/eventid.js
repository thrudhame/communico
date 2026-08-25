// sync/eventid.js — browser port of api/engine/eventid.ts (MS0 step 0).
// Mode A event ID = '$' + unpadded-base64url(sha256(canonicalJson(
// redacted event minus event_id/signatures/hashes))). Redaction rules
// (Matrix room v11/v12, prototype scope) identical to the server engine.
import { canonicalJson } from './canonical.js';

const KEEP_TOP = new Set([
  'event_id', 'type', 'room_id', 'sender', 'state_key', 'content',
  'hashes', 'signatures', 'depth', 'prev_events', 'auth_events',
  'origin_server_ts',
]);

const PL_KEYS = new Set([
  'ban', 'events', 'events_default', 'kick', 'redact', 'state_default',
  'users', 'users_default', 'invite',
]);

export function redact(event) {
  const out = {};
  for (const k of Object.keys(event)) {
    if (KEEP_TOP.has(k)) out[k] = event[k];
  }
  const content = event.content ?? {};
  const type = String(event.type ?? '');
  if (type === 'm.room.member') {
    out.content = { membership: content.membership };
  } else if (type === 'm.room.create') {
    out.content = content;
  } else if (type === 'm.room.power_levels') {
    const pl = {};
    for (const k of Object.keys(content)) {
      if (PL_KEYS.has(k)) pl[k] = content[k];
    }
    out.content = pl;
  } else if (type === 'm.room.history_visibility') {
    out.content = { history_visibility: content.history_visibility };
  } else {
    out.content = {};
  }
  return out;
}

// Note (carried from the server engine): hashes stays absent — not
// federating. Commits in the local store are per-replica receipts; the
// event id is the content hash, deterministic across replicas.
export async function eventIdFor(pdu) {
  const r = redact(pdu);
  delete r.event_id;
  delete r.signatures;
  delete r.hashes;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(r)),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return '$' + b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
