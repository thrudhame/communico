// api/engine/rulebook/rule-ids.ts — per-version rule numbering (plan D2).
// A verdict carries the VERSION's printed rule number. Seven numberings
// exist (spec tag v1.16): v1–5 (v1-auth-rules.md:16-148 /
// v3-auth-rules.md:24-149 — aliases rule 4, member 5, PL 10), v6
// (v6.md:88-213 — member unknown 4.6), v7 (v7.md:155-162 — knock 4.6,
// unknown 4.7), v8–9 (v8-auth-rules.md:30-171 — restricted 4.3.5, knock
// 4.7, unknown 4.8), v10 (v10.md:106-256), v11 (v11.md:113-260), v12
// (v12.md:94-247). Keys are stable internal names; the tables translate.
// Every table carries the union of keys so every key resolves in every
// table; keys whose rule cannot fire under a numbering (flag-gated
// branches) map to the nearest printed number with a comment.
import type { RoomVersionSpec } from './types.ts';

// v1–5 (v3–v5 at group A): 11 rules as of v3 (v3-auth-rules.md:24-149).
// v1–2 print 12 rules with the redaction rule 11 — group B.
const V1: Record<string, string> = {
  'create.prev_events': '1.1',
  'create.room_id_domain': '1.2',
  // unreachable: roomIdFromCreateEvent is v12-only
  'create.room_id_present': '1.2',
  'create.room_version': '1.3',
  'create.creator_missing': '1.4',
  // unreachable: additionalCreators is v12-only
  'create.additional_creators': '1.4',
  'create.allow': '1.5',
  // unreachable: the room_id-equals-create rule is v12-only
  'room_id.not_create': '1',
  'auth.duplicate': '2.1',
  'auth.selection': '2.2',
  'auth.rejected': '2.3',
  'auth.create_missing': '2.4',
  'auth.same_room': '2.5',
  'auth.allow': '2',
  'federate': '3',
  'aliases.no_state_key': '4.1',
  'aliases.domain_mismatch': '4.2',
  'aliases.allow': '4.3',
  'member.no_state_key': '5.1',
  // the numbered via-signature check is added-in v8
  // (v8-auth-rules.md:61-64); older prints use the member base rule
  'member.via_sig': '5',
  'member.join_create': '5.2.1',
  'member.join_self': '5.2.2',
  'member.join_banned': '5.2.3',
  'member.join_invite': '5.2.4',
  // unreachable: restrictedJoinRule is v8+ — the join falls to 5.2.6
  'member.join_restricted_member': '5.2.6',
  'member.join_restricted_via': '5.2.6',
  'member.join_restricted_allow': '5.2.6',
  'member.join_public': '5.2.5',
  'member.join_reject': '5.2.6',
  'member.invite_tpi_banned': '5.3.1.1',
  'member.invite_tpi_signed': '5.3.1.2',
  'member.invite_tpi_mxid_token': '5.3.1.3',
  'member.invite_tpi_mxid': '5.3.1.4',
  'member.invite_tpi_token': '5.3.1.5',
  'member.invite_tpi_sender': '5.3.1.6',
  'member.invite_tpi_sig': '5.3.1.7',
  'member.invite_tpi_no_sig': '5.3.1.8',
  'member.invite_sender_joined': '5.3.2',
  'member.invite_target': '5.3.3',
  'member.invite_allow': '5.3.4',
  'member.invite_level': '5.3.5',
  'member.leave_self': '5.4.1',
  'member.leave_sender_joined': '5.4.2',
  'member.leave_unban': '5.4.3',
  'member.leave_kick': '5.4.4',
  'member.leave_reject': '5.4.5',
  'member.ban_sender_joined': '5.5.1',
  'member.ban_allow': '5.5.2',
  'member.ban_reject': '5.5.3',
  // knock membership is unknown membership ≤v6 (knockJoinRule is v7+)
  'member.knock_rule': '5.6',
  'member.knock_self': '5.6',
  'member.knock_allow': '5.6',
  'member.knock_reject': '5.6',
  'member.unknown': '5.6',
  'sender_joined': '6',
  'third_party_invite': '7.1',
  'required_level': '8',
  'state_key_sender': '9',
  // ≤5 prints a single PL-structure sub-rule (v3-auth-rules.md: 10.1 —
  // users valid user IDs with integer-or-string values); the stringy
  // grammar (v1-stringy-power-levels.md:33-40) rejects under it
  'pl.types': '10.1',
  'pl.events_object': '10.1',
  'pl.users_object': '10.1',
  // unreachable: creatorsHaveInfinitePower is v12-only
  'pl.creator_in_users': '10',
  'pl.no_previous': '10.2',
  'pl.alter_current': '10.3.1',
  'pl.alter_new': '10.3.2',
  'pl.events_changed': '10.4.1',
  'pl.events_added': '10.5.1',
  'pl.users_changed': '10.6.1',
  'pl.users_added': '10.7.1',
  'pl.allow': '10.8',
  'allow': '11',
};

// v6 (v6.md:88-213): 10 rules, member unknown 4.6. The aliases rule is
// removed (v6.md:51-53) — m.room.aliases is ordinary state, terminal
// allow 10 (unreachable: aliasesAuthRule is ≤5).
const V6: Record<string, string> = {
  ...V1,
  'member.via_sig': '4',
  'member.no_state_key': '4.1',
  'member.join_create': '4.2.1',
  'member.join_self': '4.2.2',
  'member.join_banned': '4.2.3',
  'member.join_invite': '4.2.4',
  'member.join_restricted_member': '4.2.6',
  'member.join_restricted_via': '4.2.6',
  'member.join_restricted_allow': '4.2.6',
  'member.join_public': '4.2.5',
  'member.join_reject': '4.2.6',
  'member.invite_tpi_banned': '4.3.1.1',
  'member.invite_tpi_signed': '4.3.1.2',
  'member.invite_tpi_mxid_token': '4.3.1.3',
  'member.invite_tpi_mxid': '4.3.1.4',
  'member.invite_tpi_token': '4.3.1.5',
  'member.invite_tpi_sender': '4.3.1.6',
  'member.invite_tpi_sig': '4.3.1.7',
  'member.invite_tpi_no_sig': '4.3.1.8',
  'member.invite_sender_joined': '4.3.2',
  'member.invite_target': '4.3.3',
  'member.invite_allow': '4.3.4',
  'member.invite_level': '4.3.5',
  'member.leave_self': '4.4.1',
  'member.leave_sender_joined': '4.4.2',
  'member.leave_unban': '4.4.3',
  'member.leave_kick': '4.4.4',
  'member.leave_reject': '4.4.5',
  'member.ban_sender_joined': '4.5.1',
  'member.ban_allow': '4.5.2',
  'member.ban_reject': '4.5.3',
  'member.knock_rule': '4.6',
  'member.knock_self': '4.6',
  'member.knock_allow': '4.6',
  'member.knock_reject': '4.6',
  'member.unknown': '4.6',
  'aliases.no_state_key': '10',
  'aliases.domain_mismatch': '10',
  'aliases.allow': '10',
  'sender_joined': '5',
  'third_party_invite': '6.1',
  'required_level': '7',
  'state_key_sender': '8',
  'pl.types': '9.1',
  'pl.events_object': '9.1',
  'pl.users_object': '9.1',
  'pl.creator_in_users': '9',
  'pl.no_previous': '9.2',
  'pl.alter_current': '9.3.1',
  'pl.alter_new': '9.3.2',
  'pl.events_changed': '9.4.1',
  'pl.events_added': '9.5.1',
  'pl.users_changed': '9.6.1',
  'pl.users_added': '9.7.1',
  'pl.allow': '9.8',
  'allow': '10',
};

// v7 (v7.md:155-162): knock joins at 4.6, unknown moves to 4.7.
const V7: Record<string, string> = {
  ...V6,
  'member.knock_rule': '4.6.1',
  'member.knock_self': '4.6.2',
  'member.knock_allow': '4.6.3',
  'member.knock_reject': '4.6.4',
  'member.unknown': '4.7',
};

// v8–9 (v8-auth-rules.md:30-171): the via-signature check (4.2.1,
// added-in v8 :61-64), restricted join sub-rules (4.3.5), knock 4.7,
// unknown 4.8.
const V8: Record<string, string> = {
  ...V7,
  'member.via_sig': '4.2.1',
  'member.join_create': '4.3.1',
  'member.join_self': '4.3.2',
  'member.join_banned': '4.3.3',
  'member.join_invite': '4.3.4',
  'member.join_restricted_member': '4.3.5.1',
  'member.join_restricted_via': '4.3.5.2',
  'member.join_restricted_allow': '4.3.5.3',
  'member.join_public': '4.3.6',
  'member.join_reject': '4.3.7',
  'member.invite_tpi_banned': '4.4.1.1',
  'member.invite_tpi_signed': '4.4.1.2',
  'member.invite_tpi_mxid_token': '4.4.1.3',
  'member.invite_tpi_mxid': '4.4.1.4',
  'member.invite_tpi_token': '4.4.1.5',
  'member.invite_tpi_sender': '4.4.1.6',
  'member.invite_tpi_sig': '4.4.1.7',
  'member.invite_tpi_no_sig': '4.4.1.8',
  'member.invite_sender_joined': '4.4.2',
  'member.invite_target': '4.4.3',
  'member.invite_allow': '4.4.4',
  'member.invite_level': '4.4.5',
  'member.leave_self': '4.5.1',
  'member.leave_sender_joined': '4.5.2',
  'member.leave_unban': '4.5.3',
  'member.leave_kick': '4.5.4',
  'member.leave_reject': '4.5.5',
  'member.ban_sender_joined': '4.6.1',
  'member.ban_allow': '4.6.2',
  'member.ban_reject': '4.6.3',
  'member.knock_rule': '4.7.1',
  'member.knock_self': '4.7.2',
  'member.knock_allow': '4.7.3',
  'member.knock_reject': '4.7.4',
  'member.unknown': '4.8',
};

// v10 (v10.md:106-256): the v8 member numbering; PL gains the
// integer-only structure checks 9.1–9.3 (added-in v10, v10.md:221-228).
const V10: Record<string, string> = {
  ...V8,
  'pl.types': '9.1',
  'pl.events_object': '9.2',
  'pl.users_object': '9.3',
  'pl.no_previous': '9.4',
  'pl.alter_current': '9.5.1',
  'pl.alter_new': '9.5.2',
  'pl.events_changed': '9.6.1',
  'pl.events_added': '9.7.1',
  'pl.users_changed': '9.8.1',
  'pl.users_added': '9.9.1',
  'pl.allow': '9.10',
};

// v11 (v11.md:113-260): same numbering as v10 except the create rule —
// the creator property is removed (v11.md:65-68), so 1.4 is the allow
// and creator_missing is unreachable (explicitCreator false).
const V11: Record<string, string> = { ...V10, 'create.allow': '1.4' };

const V12: Record<string, string> = {
  'create.prev_events': '1.1',
  'create.room_id_present': '1.2',
  // unreachable: roomIdFromCreateEvent is on — creates carry no room_id
  'create.room_id_domain': '1.2',
  'create.room_version': '1.3',
  'create.additional_creators': '1.4',
  // unreachable: explicitCreator is ≤10 (v12 creators are the sender ∪
  // additional_creators — v12.md:65-73)
  'create.creator_missing': '1.4',
  'create.allow': '1.5',
  'room_id.not_create': '2',
  'auth.duplicate': '3.1',
  'auth.selection': '3.2',
  'auth.rejected': '3.3',
  // 3.4 is skipped in v12 (v11's 2.4 "create missing" — v12.md:110-122
  // prints the sub-list 1,2,3,5); unreachable: createInAuthEvents false
  'auth.create_missing': '3',
  'auth.same_room': '3.5',
  'auth.allow': '3',
  'federate': '4',
  // unreachable: aliasesAuthRule is ≤5 (removed in v6 — v6.md:51-53)
  'aliases.no_state_key': '11',
  'aliases.domain_mismatch': '11',
  'aliases.allow': '11',
  'member.no_state_key': '5.1',
  'member.via_sig': '5.2.1',
  'member.join_create': '5.3.1',
  'member.join_self': '5.3.2',
  'member.join_banned': '5.3.3',
  'member.join_invite': '5.3.4',
  'member.join_restricted_member': '5.3.5.1',
  'member.join_restricted_via': '5.3.5.2',
  'member.join_restricted_allow': '5.3.5.3',
  'member.join_public': '5.3.6',
  'member.join_reject': '5.3.7',
  'member.invite_tpi_banned': '5.4.1.1',
  'member.invite_tpi_signed': '5.4.1.2',
  'member.invite_tpi_mxid_token': '5.4.1.3',
  'member.invite_tpi_mxid': '5.4.1.4',
  'member.invite_tpi_token': '5.4.1.5',
  'member.invite_tpi_sender': '5.4.1.6',
  'member.invite_tpi_sig': '5.4.1.7',
  'member.invite_tpi_no_sig': '5.4.1.8',
  'member.invite_sender_joined': '5.4.2',
  'member.invite_target': '5.4.3',
  'member.invite_allow': '5.4.4',
  'member.invite_level': '5.4.5',
  'member.leave_self': '5.5.1',
  'member.leave_sender_joined': '5.5.2',
  'member.leave_unban': '5.5.3',
  'member.leave_kick': '5.5.4',
  'member.leave_reject': '5.5.5',
  'member.ban_sender_joined': '5.6.1',
  'member.ban_allow': '5.6.2',
  'member.ban_reject': '5.6.3',
  'member.knock_rule': '5.7.1',
  'member.knock_self': '5.7.2',
  'member.knock_allow': '5.7.3',
  'member.knock_reject': '5.7.4',
  'member.unknown': '5.8',
  'sender_joined': '6',
  'third_party_invite': '7.1',
  'required_level': '8',
  'state_key_sender': '9',
  'pl.types': '10.1',
  'pl.events_object': '10.2',
  'pl.users_object': '10.3',
  'pl.creator_in_users': '10.4',
  'pl.no_previous': '10.5',
  'pl.alter_current': '10.6.1',
  'pl.alter_new': '10.6.2',
  'pl.events_changed': '10.7.1',
  'pl.events_added': '10.8.1',
  'pl.users_changed': '10.9.1',
  'pl.users_added': '10.10.1',
  // v12.md:246 prints the PL allow as "10" — a spec typo duplicating
  // 10.10; the logical sub-number is 10.11.
  'pl.allow': '10.11',
  'allow': '11',
};

const TABLES: Record<RoomVersionSpec['ruleNumbering'], Record<string, string>> =
  {
    v1: V1,
    v6: V6,
    v7: V7,
    v8: V8,
    v10: V10,
    v11: V11,
    v12: V12,
  };

// Exported for the rule-ids corpus (tests/rulebook/rule-ids.test.ts):
// every key resolves in every table.
export const RULE_ID_TABLES = TABLES;

// The printed number for a stable key under this version's rules — the
// table is selected by spec.ruleNumbering, never by identifier (plan D2).
// Throws on a key the table doesn't know — a missing key is a wiring
// bug, never a silent fallback.
export function ruleId(spec: RoomVersionSpec, key: string): string {
  const id = TABLES[spec.ruleNumbering][key];
  if (id === undefined) {
    throw new Error(
      `no rule id for '${key}' at room version ${spec.identifier}`,
    );
  }
  return id;
}
