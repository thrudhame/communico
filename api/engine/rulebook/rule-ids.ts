// api/engine/rulebook/rule-ids.ts — per-version rule numbering (plan D1).
// A verdict carries the VERSION's printed rule number: v12 inserts rules
// 1.4 and 2 (and 10.4), shifting v11's 2–10 to 3–11 (v12.md:94-247 vs
// v11.md:113-260). Keys are stable internal names; the tables translate.
// v10 shares v11's numbering for the shared rules (v10.md:105-276) — its
// only extra check keys in below.
import type { RoomVersionSpec } from './types.ts';

const V11: Record<string, string> = {
  'create.prev_events': '1.1',
  'create.room_id_domain': '1.2',
  'create.room_version': '1.3',
  'create.creator_missing': '1.4', // v10.md:114 (v10 only)
  'create.allow': '1.4',
  'auth.duplicate': '2.1',
  'auth.selection': '2.2',
  'auth.rejected': '2.3',
  'auth.create_missing': '2.4',
  'auth.same_room': '2.5',
  'auth.allow': '2',
  'federate': '3',
  'member.no_state_key': '4.1',
  'member.via_sig': '4.2.1',
  'member.join_create': '4.3.1',
  'member.join_self': '4.3.2',
  'member.join_banned': '4.3.3',
  'member.join_invite': '4.3.4',
  'member.join_restricted_member': '4.3.5.1',
  'member.join_restricted_via': '4.3.5.2',
  'member.join_restricted_allow': '4.3.5.3',
  'member.join_public': '4.3.6',
  'member.invite_tpi_banned': '4.4.1.1',
  'member.invite_tpi_signed': '4.4.1.2',
  'member.invite_tpi_mxid_token': '4.4.1.3',
  'member.invite_tpi_mxid': '4.4.1.4',
  'member.invite_tpi_token': '4.4.1.5',
  'member.invite_tpi_sig': '4.4.1.7',
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
  'sender_joined': '5',
  'third_party_invite': '6.1',
  'required_level': '7',
  'state_key_sender': '8',
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
  'allow': '10',
};

const V12: Record<string, string> = {
  'create.prev_events': '1.1',
  'create.room_id_present': '1.2',
  'create.room_version': '1.3',
  'create.additional_creators': '1.4',
  'create.allow': '1.5',
  'room_id.not_create': '2',
  'auth.duplicate': '3.1',
  'auth.selection': '3.2',
  'auth.rejected': '3.3',
  // 3.4 is skipped in v12 (v11's 2.4 "create missing" — v12.md:110-122
  // prints the sub-list 1,2,3,5)
  'auth.same_room': '3.5',
  'auth.allow': '3',
  'federate': '4',
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
  'member.invite_tpi_banned': '5.4.1.1',
  'member.invite_tpi_signed': '5.4.1.2',
  'member.invite_tpi_mxid_token': '5.4.1.3',
  'member.invite_tpi_mxid': '5.4.1.4',
  'member.invite_tpi_token': '5.4.1.5',
  'member.invite_tpi_sig': '5.4.1.7',
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

// The printed number for a stable key under this version's rules. Throws
// on a key the version's table doesn't know — a missing key is a wiring
// bug, never a silent fallback.
export function ruleId(spec: RoomVersionSpec, key: string): string {
  const table = spec.identifier === '12' ? V12 : V11;
  const id = table[key];
  if (id === undefined) {
    throw new Error(
      `no rule id for '${key}' at room version ${spec.identifier}`,
    );
  }
  return id;
}
