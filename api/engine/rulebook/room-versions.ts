// api/engine/rulebook/room-versions.ts — the RoomVersionSpec records
// (plan §3b). v11 fully specified; V12 registered by the v12 plan.
//
// Flag sources (spec tag v1.16):
// - stateResVariant 'v2': content/rooms/v11.md:39-44 (v2-state-res.md:18-20)
// - createInAuthEvents true: v11.md:131 note ("This room version requires
//   an m.room.create event to be selected"); auth-events selection
//   server-server-api.md:535-536
// - explicitCreator false (no `creator` field): v11 event format, and
//   m.room.power_levels.yaml:99-101 ("In room versions 1 through 11, when
//   there is no m.room.power_levels event in the room, the room creator has
//   a power level of 100")
// - enforceIntPowerLevels: v10.md:67-74, 221-228
// - knockJoinRule: v7; restrictedJoinRule: v8; knockRestrictedJoinRule:
//   v10 (v11 supports all — v11.md feature list)
// - redactionRules 'v11': v11.md includes v11-redactions
// - authEventsSameRoom: v11.md:136-137 (rule 2.5, changed-in v1.16)
// v12 differences (content/rooms/v12.md:8-10, 65-73, 89-108, 219-221,
// 266-274, 330-339): no create in auth_events, room id from the create
// event, infinite creator power, additional_creators, state res v2.1.
import type { RoomVersionSpec } from './types.ts';

export const V11: RoomVersionSpec = {
  identifier: '11',
  ruleNumbering: 'v11',
  stateResVariant: 'v2',
  createInAuthEvents: true,
  roomIdFromCreateEvent: false,
  explicitCreator: false,
  creatorsHaveInfinitePower: false,
  additionalCreators: false,
  enforceIntPowerLevels: true,
  aliasesAuthRule: false,
  notificationsInPlRules: true,
  strictCanonicalJson: true,
  depthLimit: 'int53',
  enforceKeyValidity: true,
  eventIdAlphabet: 'urlsafe',
  redactsInContent: true,
  knockJoinRule: true,
  restrictedJoinRule: true,
  knockRestrictedJoinRule: true,
  redactionRules: 'v11',
  authEventsSameRoom: true,
};

// Room version 12 (content/rooms/v12.md): creators (sender +
// additional_creators) hold infinite power, the room id is the create
// event's id, create is never selected into auth_events, state
// resolution v2.1. Redactions stay the v11 fragment (v12.md:485).
export const V12: RoomVersionSpec = {
  ...V11,
  identifier: '12',
  ruleNumbering: 'v12',
  stateResVariant: 'v2.1',
  createInAuthEvents: false,
  roomIdFromCreateEvent: true,
  creatorsHaveInfinitePower: true,
  additionalCreators: true,
};

// Room version 10 (content/rooms/v10.md): the explicit creator
// (content.creator required — v10.md:114) and the v9-redactions
// keep-list (v10.md:276). Everything else as v11: create is selected
// into auth_events (v10.md:122 note), v2 state-res (v10.md:292), all
// join rules incl. knock_restricted (v10 feature), auth-events same-room
// (retroactive at v1.16, plan D6).
export const V10: RoomVersionSpec = {
  ...V11,
  identifier: '10',
  ruleNumbering: 'v10',
  explicitCreator: true,
  redactionRules: 'v9',
  // ≤10 carries `redacts` top-level on the PDU (pdu_v6.yaml:27-30); the
  // move to content is v11 (v11.md:70-81)
  redactsInContent: false,
};

// Room versions 3–9 (the older-versions plan, group A): every one is
// v11 with switches — the survey diffed each content/rooms/vN.md and its
// fragments against v11 and found no new algorithm. Shared ≤9 base:
// the explicit creator (≤10 — v3-auth-rules.md:32), stringy power
// levels (v1-stringy-power-levels.md:2-40), top-level redacts
// (pdu_v6.yaml:27-30), v2 state res, create in auth_events, the
// auth-events same-room rule (retroactive at v1.16), no
// knock_restricted (v10 feature).
const V9_BASE: RoomVersionSpec = {
  ...V10,
  enforceIntPowerLevels: false,
  knockJoinRule: false,
  restrictedJoinRule: false,
  knockRestrictedJoinRule: false,
};

// v9 (content/rooms/v9.md): v8 + the member redaction keeps
// join_authorised_via_users_server (v9.md:21-23 — the v9-redactions
// fragment, v9.md:42).
export const V9: RoomVersionSpec = {
  ...V9_BASE,
  identifier: '9',
  ruleNumbering: 'v8',
  knockJoinRule: true,
  restrictedJoinRule: true,
  redactionRules: 'v9',
};

// v8 (content/rooms/v8.md): restricted join rooms (v8-auth-rules.md
// :72-78), the inline redaction table (v8.md:42-69).
export const V8: RoomVersionSpec = {
  ...V9_BASE,
  identifier: '8',
  ruleNumbering: 'v8',
  knockJoinRule: true,
  restrictedJoinRule: true,
  redactionRules: 'v8',
};

// v7 (content/rooms/v7.md): knocking (v7.md:155-161); v6-redactions
// (v7.md:220).
export const V7: RoomVersionSpec = {
  ...V9_BASE,
  identifier: '7',
  ruleNumbering: 'v7',
  knockJoinRule: true,
  redactionRules: 'v6',
};

// v6 (content/rooms/v6.md): the aliases rule removed (v6.md:51-53),
// `notifications` in the PL rules (v6.md:55-58, 195-204), strict
// canonical JSON and the 2^53 depth limit (v6-canonical-json.md,
// depth_v6.yaml:18-24), v6-redactions (v6-redactions.md:5-31).
export const V6: RoomVersionSpec = {
  ...V9_BASE,
  identifier: '6',
  ruleNumbering: 'v6',
  notificationsInPlRules: true,
  strictCanonicalJson: true,
  depthLimit: 'int53',
  redactionRules: 'v6',
};

// v5 (content/rooms/v5.md): signing-key validity enforced
// (v5-signing-requirements.md:2-16 — recorded; the effect is federation
// signature verification, M5), URL-safe event ids (v4-event-ids.md
// :3-12), v1-redactions (v1-redactions.md:5-32).
export const V5: RoomVersionSpec = {
  ...V9_BASE,
  identifier: '5',
  ruleNumbering: 'v1',
  aliasesAuthRule: true,
  notificationsInPlRules: false,
  strictCanonicalJson: false,
  depthLimit: 'int63',
  enforceKeyValidity: true,
  redactionRules: 'v1',
};

// v4 (content/rooms/v4.md): v3 + URL-safe event ids
// (v4-event-ids.md:3-12).
export const V4: RoomVersionSpec = {
  ...V5,
  identifier: '4',
  enforceKeyValidity: false,
};

// v3 (content/rooms/v3.md): event ids are the reference hash in
// STANDARD (non-URL-safe) base64 (v3.md:57-62) — ids may contain + and
// / (v3.md:13-22); the v3-auth-rules fragment (v3-auth-rules.md:24-149).
export const V3: RoomVersionSpec = {
  ...V4,
  identifier: '3',
  eventIdAlphabet: 'std',
};
