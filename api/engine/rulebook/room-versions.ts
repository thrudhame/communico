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
  stateResVariant: 'v2',
  createInAuthEvents: true,
  roomIdFromCreateEvent: false,
  explicitCreator: false,
  creatorsHaveInfinitePower: false,
  additionalCreators: false,
  enforceIntPowerLevels: true,
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
  explicitCreator: true,
  redactionRules: 'v9',
};
