import { canonicalJson } from './canonical.ts';
import { getRulebook } from './policy.ts';

// Redaction keep-lists, TRANSCRIBED from the spec during execution
// (never recalled). v11-redactions (v11.md / v12.md:485):
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
//
// v9-redactions (v10.md:276 includes the fragment):
//
// Top-level KEEP: the v11 list PLUS prev_state, origin, membership.
// Content KEEP per type:
// - m.room.member: membership, join_authorised_via_users_server (no
//   third_party_invite signed reduction).
// - m.room.create: creator ONLY.
// - m.room.join_rules: join_rule, allow.
// - m.room.power_levels: ban, events, events_default, kick, redact,
//   state_default, users, users_default (NO invite).
// - m.room.history_visibility: history_visibility.
// - anything else: {} (no m.room.redaction content key).
//
// v8 (inline table, v8.md:42-69): the v9 lists EXCEPT m.room.member
// keeps membership only (no join_authorised_via_users_server — that is
// the v9 fix, v9.md:21-23).
//
// v6-redactions (v6-redactions.md:5-31): the v8 lists EXCEPT
// m.room.join_rules keeps join_rule only (no allow — restricted rooms
// are v8).
//
// v1-redactions (v1-redactions.md:5-32): the v6 lists PLUS
// m.room.aliases keeps `aliases` (:30 — ≤5 only).

const KEEP_TOP_V11 = new Set([
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

// The 15-key top-level list shared by v1/v6/v8/v9
// (v1-redactions.md:5-19).
const KEEP_TOP_LEGACY = new Set([
  ...KEEP_TOP_V11,
  'prev_state',
  'origin',
  'membership',
]);

const PL_KEYS_V11 = new Set([
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

// The 8-key PL list shared by v1/v6/v8/v9 (v1-redactions.md:27-29 — no
// invite, no notifications).
const PL_KEYS_LEGACY = new Set([
  'ban',
  'events',
  'events_default',
  'kick',
  'redact',
  'state_default',
  'users',
  'users_default',
]);

// Matrix redaction algorithm, dispatched per room version's redaction
// fragment (spec.redactionRules, plan D6): '11' and '12' share the v11
// list; '10' uses the v9 list (v10.md:276); '8' the inline v8 table;
// '6'/'7' the v6 fragment; '3'-'5' the v1 fragment. Unknown versions
// throw via the registry (never a default).
export function redact(
  event: Record<string, unknown>,
  roomVersion = '11',
): Record<string, unknown> {
  const rules = getRulebook(roomVersion).spec.redactionRules;
  const legacy = rules !== 'v11';
  const keepTop = legacy ? KEEP_TOP_LEGACY : KEEP_TOP_V11;
  const plKeys = legacy ? PL_KEYS_LEGACY : PL_KEYS_V11;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(event)) {
    if (keepTop.has(k)) out[k] = event[k];
  }
  const content = (event.content ?? {}) as Record<string, unknown>;
  const type = String(event.type ?? '');
  if (type === 'm.room.member') {
    const kept: Record<string, unknown> = {};
    if ('membership' in content) kept.membership = content.membership;
    // join_authorised_via_users_server survives from v9 (v9.md:21-23).
    if (
      (rules === 'v9' || rules === 'v11') &&
      'join_authorised_via_users_server' in content
    ) {
      kept.join_authorised_via_users_server =
        content.join_authorised_via_users_server;
    }
    if (rules === 'v11') {
      const tpi = content.third_party_invite as
        | Record<string, unknown>
        | undefined;
      if (tpi !== null && typeof tpi === 'object' && 'signed' in tpi) {
        kept.third_party_invite = { signed: tpi.signed };
      }
    }
    out.content = kept;
  } else if (type === 'm.room.create') {
    out.content = rules === 'v11'
      ? content
      : ('creator' in content ? { creator: content.creator } : {});
  } else if (type === 'm.room.join_rules') {
    const kept: Record<string, unknown> = {};
    if ('join_rule' in content) kept.join_rule = content.join_rule;
    // `allow` survives from v8 (v8.md:66).
    if (
      (rules === 'v8' || rules === 'v9' || rules === 'v11') &&
      'allow' in content
    ) {
      kept.allow = content.allow;
    }
    out.content = kept;
  } else if (type === 'm.room.power_levels') {
    const pl: Record<string, unknown> = {};
    for (const k of Object.keys(content)) {
      if (plKeys.has(k)) pl[k] = content[k];
    }
    out.content = pl;
  } else if (type === 'm.room.aliases' && rules === 'v1') {
    // ≤5 only (v1-redactions.md:30; plan 3c).
    out.content = 'aliases' in content ? { aliases: content.aliases } : {};
  } else if (type === 'm.room.history_visibility') {
    out.content = { history_visibility: content.history_visibility };
  } else if (type === 'm.room.redaction' && rules === 'v11') {
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
