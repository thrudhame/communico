// sync/eventid.js — browser port of api/engine/eventid.ts.
// Room v11 redaction rules, TRANSCRIBED from the spec during execution
// (never recalled) — https://spec.matrix.org/v1.11/rooms/v11/ ,
// section "Client considerations → Redactions". Same KEEP table as the
// server engine (see api/engine/eventid.ts for the line-by-line cite);
// notably m.room.power_levels keeps ban/events/events_default/invite/
// kick/redact/state_default/users/users_default and NOT notifications.
import { canonicalJson } from './canonical.js';

const KEEP_TOP = new Set([
  'event_id', 'type', 'room_id', 'sender', 'state_key', 'content',
  'hashes', 'signatures', 'depth', 'prev_events', 'auth_events',
  'origin_server_ts',
]);

const PL_KEYS = new Set([
  'ban', 'events', 'events_default', 'invite', 'kick', 'redact',
  'state_default', 'users', 'users_default',
]);

export function redact(event, roomVersion = '11') {
  if (roomVersion !== '11') {
    throw new Error('M_UNSUPPORTED_ROOM_VERSION: ' + String(roomVersion));
  }
  const out = {};
  for (const k of Object.keys(event)) {
    if (KEEP_TOP.has(k)) out[k] = event[k];
  }
  const content = event.content ?? {};
  const type = String(event.type ?? '');
  if (type === 'm.room.member') {
    const kept = {};
    if ('membership' in content) kept.membership = content.membership;
    if ('join_authorised_via_users_server' in content) {
      kept.join_authorised_via_users_server =
        content.join_authorised_via_users_server;
    }
    const tpi = content.third_party_invite;
    if (tpi !== null && typeof tpi === 'object' && 'signed' in tpi) {
      kept.third_party_invite = { signed: tpi.signed };
    }
    out.content = kept;
  } else if (type === 'm.room.create') {
    out.content = content;
  } else if (type === 'm.room.join_rules') {
    const kept = {};
    if ('join_rule' in content) kept.join_rule = content.join_rule;
    if ('allow' in content) kept.allow = content.allow;
    out.content = kept;
  } else if (type === 'm.room.power_levels') {
    const pl = {};
    for (const k of Object.keys(content)) {
      if (PL_KEYS.has(k)) pl[k] = content[k];
    }
    out.content = pl;
  } else if (type === 'm.room.history_visibility') {
    out.content = { history_visibility: content.history_visibility };
  } else if (type === 'm.room.redaction') {
    out.content = { redacts: content.redacts };
  } else {
    out.content = {};
  }
  return out;
}

// Reference hash: redact -> drop event_id/signatures/unsigned (hashes
// KEPT) -> canonical JSON -> SHA-256 -> '$' + unpadded base64url.
export async function eventIdFor(pdu, roomVersion = '11') {
  const r = redact(pdu, roomVersion);
  delete r.event_id;
  delete r.signatures;
  delete r.unsigned;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(r)),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return '$' + b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
