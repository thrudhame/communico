// api/engine/policy.ts — thin re-export shim (plan §3c): the real surface
// lives in #engine/rulebook/index.ts. The getRulebook/
// supportedRoomVersions/stateKeyOf names are kept so room.ts,
// capabilities/get.ts and adopt.ts don't churn.
export {
  getRulebook,
  stateKeyOf,
  supportedRoomVersions,
} from './rulebook/index.ts';
export type {
  EventStore,
  Pdu,
  RoomVersionSpec,
  Rulebook,
  StateMap,
  Verdict,
} from './rulebook/types.ts';
