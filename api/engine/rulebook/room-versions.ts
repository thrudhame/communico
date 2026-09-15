// api/engine/rulebook/room-versions.ts — the RoomVersionSpec records
// (plan §3b). v11 fully specified; V12 declared but NOT registered —
// registration is the v12 plan's first line (plan §3a).
//
// Flag sources (spec tag v1.16):
// - stateResVariant 'v2': content/rooms/v11.md:39-44 (v2-state-res.md:18-20)
// - createInAuthEvents true: v11.md:131 note ("This room version requires
//   an m.room.create event to be selected"); auth-events selection
//   server-server-api.md:535-536
// - implicitRoomCreator (no `creator` field): v11 event format, and
//   m.room.power_levels.yaml:99-101 ("In room versions 1 through 11, when
//   there is no m.room.power_levels event in the room, the room creator has
//   a power level of 100")
// - enforceIntPowerLevels: v10.md:67-74, 221-228
// - knockJoinRule: v7; restrictedJoinRule: v8; knockRestrictedJoinRule:
//   v10 (v11 supports all — v11.md feature list)
// - updatedRedactionRules: v3-handling-redactions.md:3-6 (v3+)
// - authEventsSameRoom: v11.md:136-137 (rule 2.5, changed-in v1.16)
// v12 differences (declared only; content/rooms/v12.md:8-10, 89-108,
// 219-221, 270-282, 330-339): no create in auth_events, room id from the
// create event, infinite creator power, state res v2.1.
import type { RoomVersionSpec } from './types.ts';

export const V11: RoomVersionSpec = {
  identifier: '11',
  stateResVariant: 'v2',
  createInAuthEvents: true,
  roomIdFromCreateEvent: false,
  implicitRoomCreator: true,
  creatorsHaveInfinitePower: false,
  enforceIntPowerLevels: true,
  knockJoinRule: true,
  restrictedJoinRule: true,
  knockRestrictedJoinRule: true,
  updatedRedactionRules: true,
  authEventsSameRoom: true,
};

// DECLARED but NOT REGISTERED — the v12 plan registers it (plan §3a).
export const V12: RoomVersionSpec = {
  ...V11,
  identifier: '12',
  stateResVariant: 'v2.1',
  createInAuthEvents: false,
  roomIdFromCreateEvent: true,
  creatorsHaveInfinitePower: true,
};
