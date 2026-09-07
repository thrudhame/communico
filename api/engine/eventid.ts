import { canonicalJson } from './canonical.ts';

// Room v11 redaction rules, TRANSCRIBED from the spec during execution
// (never recalled) — https://spec.matrix.org/v1.11/rooms/v11/ ,
// section "Client considerations → Redactions" ("Upon receipt of a
// redaction event, the server must strip off any keys not in the
// following list"):
//
// Top-level KEEP: event_id, type, room_id, sender, state_key, content,
// hashes, signatures, depth, prev_events, auth_events, origin_server_ts.
// Content KEEP per type:
// - m.room.member: membership, join_authorised_via_users_server;
//   third_party_invite reduced to its `signed` key only.
// - m.room.create: all keys.
// - m.room.join_rules: join_rule, allow.
// - m.room.power_levels: ban, events, events_default, invite, kick,
//   redact, state_default, users, users_default.
//   (NOT `notifications` — caught from memory-error in review R9.)
// - m.room.history_visibility: history_visibility.
// - m.room.redaction: redacts.
// - anything else: {}.
// Top-level `origin`, `membership`, `prev_state` are NOT protected in
// v11 (removed vs older versions); there is no top-level `redacts`
// (moved under content in v11).

const KEEP_TOP = new Set([
  'event_id',
  'type',
  'room_id',
  'sender',
  'state_key',
  'content',
  'hashes',
  'signatures',
  'depth',
  'prev_events',
  'auth_events',
  'origin_server_ts',
]);

const PL_KEYS = new Set([
  'ban',
  'events',
  'events_default',
  'invite',
  'kick',
  'redact',
  'state_default',
  'users',
  'users_default',
]);

// Matrix redaction algorithm, dispatched per room version. F0 supports
// '11' only (getRulebook rejects the rest); M3 adds the v11-final/v12
// family behind the same signature.
export function redact(
  event: Record<string, unknown>,
  roomVersion = '11',
): Record<string, unknown> {
  if (roomVersion !== '11') {
    throw new Error('M_UNSUPPORTED_ROOM_VERSION: ' + String(roomVersion));
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(event)) {
    if (KEEP_TOP.has(k)) out[k] = event[k];
  }
  const content = (event.content ?? {}) as Record<string, unknown>;
  const type = String(event.type ?? '');
  if (type === 'm.room.member') {
    const kept: Record<string, unknown> = {};
    if ('membership' in content) kept.membership = content.membership;
    if ('join_authorised_via_users_server' in content) {
      kept.join_authorised_via_users_server =
        content.join_authorised_via_users_server;
    }
    const tpi = content.third_party_invite as
      | Record<string, unknown>
      | undefined;
    if (tpi !== null && typeof tpi === 'object' && 'signed' in tpi) {
      kept.third_party_invite = { signed: tpi.signed };
    }
    out.content = kept;
  } else if (type === 'm.room.create') {
    out.content = content;
  } else if (type === 'm.room.join_rules') {
    const kept: Record<string, unknown> = {};
    if ('join_rule' in content) kept.join_rule = content.join_rule;
    if ('allow' in content) kept.allow = content.allow;
    out.content = kept;
  } else if (type === 'm.room.power_levels') {
    const pl: Record<string, unknown> = {};
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

// Reference hash (spec server-server API § "Calculating the reference
// hash for an event"): redact -> remove `signatures` and `unsigned`
// (hashes is KEPT — it covers the essential fields including content
// hashes) -> canonical JSON -> SHA-256 -> '$' + unpadded base64url.
// `event_id` itself is excluded (it is the derived value, never input).
export async function eventIdFor(
  pdu: Record<string, unknown>,
  roomVersion = '11',
): Promise<string> {
  const r = redact(pdu, roomVersion);
  delete r.event_id;
  delete r.signatures;
  delete r.unsigned;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(r)),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return '$' + b64.replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  );
}
