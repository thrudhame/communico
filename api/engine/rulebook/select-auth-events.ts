// api/engine/rulebook/select-auth-events.ts — the auth events selection
// algorithm (plan §3a; moved from the F0 stub and re-verified). Spec tag
// v1.16, content/server-server-api.md:528-554 ("Auth events selection"):
//
//   The auth_events for the m.room.create event in a room is empty; for
//   other events, it should be the following subset of the room state:
//   - (changed-in v1.16) Depending on the room version, the m.room.create
//     event.                                     [535-536]
//   - The current m.room.power_levels event, if any. [538]
//   - The sender's current m.room.member event, if any. [540]
//   - If type is m.room.member:                      [542]
//     - the target's current m.room.member event, if any; [544]
//     - if membership is join, invite or knock, the current join_rules
//       event, if any;                                [545-546]
//     - if membership is invite and content has third_party_invite, the
//       m.room.third_party_invite event with state_key matching
//       content.third_party_invite.signed.token, if any; [547-550]
//     - if membership is join, join_authorised_via_users_server is
//       present, and the room version supports restricted rooms, the
//       m.room.member event with state_key matching the key. [551-554]
//
// Deterministic order (plan §3a): create, PL, sender-member, then the
// sorted tail — the F0 stub's slice(0,3) head/tail bug is fixed by
// construction (head is exactly the first three selection slots).
import type { Pdu, RoomVersionSpec, StateMap } from './types.ts';
import { stateKeyOf } from './types.ts';

export function selectAuthEvents(
  pdu: Pdu,
  state: StateMap,
  spec: RoomVersionSpec,
): string[] {
  // The m.room.create event's auth_events are empty (S3 531-532).
  if (pdu.type === 'm.room.create') return [];

  const out: string[] = [];
  const push = (id: string | undefined) => {
    if (id !== undefined && !out.includes(id)) out.push(id);
  };

  // The create event, per room version (flag: createInAuthEvents).
  if (spec.createInAuthEvents) {
    push(state.get(stateKeyOf('m.room.create', '')));
  }
  // The current m.room.power_levels event, if any.
  push(state.get(stateKeyOf('m.room.power_levels', '')));
  // The sender's current m.room.member event, if any.
  push(state.get(stateKeyOf('m.room.member', pdu.sender)));

  if (pdu.type === 'm.room.member') {
    const membership = pdu.content?.membership;
    const targetKey = pdu.state_key ?? '';
    // The target's current m.room.member event, if any.
    if (targetKey !== pdu.sender) {
      push(state.get(stateKeyOf('m.room.member', targetKey)));
    }
    // join/invite/knock -> the current join_rules event, if any.
    if (
      membership === 'join' || membership === 'invite' || membership === 'knock'
    ) {
      push(state.get(stateKeyOf('m.room.join_rules', '')));
    }
    // invite with third_party_invite -> the token's third_party_invite
    // event, if any.
    if (membership === 'invite' && pdu.content?.third_party_invite) {
      const signed = (pdu.content.third_party_invite as {
        signed?: { token?: unknown };
      }).signed;
      if (signed && typeof signed.token === 'string') {
        push(state.get(stateKeyOf('m.room.third_party_invite', signed.token)));
      }
    }
    // join with join_authorised_via_users_server on a version supporting
    // restricted rooms -> that user's member event, if any.
    const viaUser = pdu.content?.join_authorised_via_users_server;
    if (
      membership === 'join' && spec.restrictedJoinRule &&
      typeof viaUser === 'string' && viaUser.length > 0
    ) {
      push(state.get(stateKeyOf('m.room.member', viaUser)));
    }
  }

  // Deterministic order: the head is exactly the fixed slots above
  // (create, PL, sender member — omitted slots stay absent); everything
  // after is sorted.
  const head = out.slice(0, 3);
  const tail = out.slice(3).sort();
  return [...head, ...tail];
}
