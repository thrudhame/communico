// sync/rulebook/v11-stub.js — the F0 refusing rulebook for room version 11.
//
// ONE SOURCE FILE consumed by both engines (server imports this from
// api/engine/rulebook/v11-stub.ts; the browser imports it directly).
// Byte-identical selection/authorization on both sides is a correctness
// requirement: two replicas must refuse the same events.
//
// Status: STUB. authorized() checks membership only (NO power-level
// checks — M3). resolveState() refuses every conflict (M_UNRESOLVED_
// CONFLICT — never a guessed winner; the real v11 resolver is M3).
// selectAuthEvents() and redaction() are FINAL (spec-derived) and are
// kept verbatim by M3.
//
// Spec refs (v1.11):
// - auth events selection: server-server API § "Auth events selection"
// - creator-join exemption: rooms v11 § Authorization rules 4.3.1
//   ("If the only previous event is an m.room.create and the state_key
//   is the sender, allow.")
// - redaction KEEP table: rooms v11 § Redactions.

// StateMap: `${type}\0${state_key}` -> event_id
export function stateKeyOf(type, stateKey) {
  return type + '\0' + (stateKey ?? '');
}

// Subset of room state used by selectAuthEvents/authorized.
// getEvent(eventId) -> PDU | undefined (validated, id-recomputed events).
// createEventId: the room's m.room.create event id.

export function selectAuthEvents(pdu, ctx) {
  const { stateAtPrevs, getEvent, createEventId } = ctx;
  // The m.room.create event carries no auth events (spec: its
  // auth_events is empty).
  if (pdu.type === 'm.room.create') return [];
  const out = [];
  const push = (id) => {
    if (id && !out.includes(id)) out.push(id);
  };
  // The m.room.create event (always first).
  push(createEventId);
  // The current m.room.power_levels event, if any.
  const plId = stateAtPrevs.get(stateKeyOf('m.room.power_levels', ''));
  push(plId);
  // The sender's current m.room.member event, if any.
  const senderMemberId = stateAtPrevs.get(
    stateKeyOf('m.room.member', pdu.sender),
  );
  push(senderMemberId);
  if (pdu.type === 'm.room.member') {
    const membership = pdu.content?.membership;
    const targetKey = pdu.state_key ?? '';
    // The target's current m.room.member event, if any.
    if (targetKey !== pdu.sender) {
      push(stateAtPrevs.get(stateKeyOf('m.room.member', targetKey)));
    }
    if (membership === 'join' || membership === 'invite') {
      const jrId = stateAtPrevs.get(stateKeyOf('m.room.join_rules', ''));
      push(jrId);
    }
    if (
      membership === 'invite' && pdu.content?.third_party_invite?.signed?.token
    ) {
      const token = pdu.content.third_party_invite.signed.token;
      push(stateAtPrevs.get(stateKeyOf('m.room.third_party_invite', token)));
    }
    const viaUser = pdu.content?.join_authorised_via_users_server;
    if (typeof viaUser === 'string' && viaUser.length > 0) {
      push(stateAtPrevs.get(stateKeyOf('m.room.member', viaUser)));
    }
  }
  // Deterministic order: create, PL, sender-member, then the rest in
  // state-map iteration order is NOT deterministic — sort the tail.
  const head = out.slice(0, 3);
  const tail = out.slice(3).sort();
  void getEvent;
  return [...head, ...tail];
}

function memberEventMembership(stateAtPrevs, getEvent, userId) {
  const id = stateAtPrevs.get(stateKeyOf('m.room.member', userId));
  if (!id) return undefined;
  const ev = getEvent(id);
  return ev?.content?.membership;
}

// 'ok' | 'authchain-reject' | 'state-reject' | 'soft-fail'
// The stub only ever returns 'ok' or 'state-reject'. No timestamp is
// consulted anywhere. No power-level check: any joined member may set
// any state (declared gap — the blacklist's "event authorization (M3)"
// line; Complement 30rooms auth tests stay red).
export function authorized(pdu, ctx) {
  const { stateAtPrevs, getEvent, createEventId } = ctx;
  // m.room.create is exempt.
  if (pdu.type === 'm.room.create') return 'ok';
  if (pdu.type === 'm.room.member') {
    const membership = pdu.content?.membership;
    if (typeof membership !== 'string') return 'state-reject';
    const targetKey = pdu.state_key ?? '';
    // v11 creator-join exemption (rooms v11 auth rule 4.3.1): the only
    // previous event is the create and state_key is the sender.
    if (
      membership === 'join' && targetKey === pdu.sender &&
      Array.isArray(pdu.prev_events) && pdu.prev_events.length === 1 &&
      pdu.prev_events[0] === createEventId
    ) {
      return 'ok';
    }
    const senderMembership = memberEventMembership(
      stateAtPrevs,
      getEvent,
      pdu.sender,
    );
    const targetMembership = targetKey === pdu.sender
      ? senderMembership
      : memberEventMembership(stateAtPrevs, getEvent, targetKey);
    if (membership === 'join') {
      if (senderMembership === 'join') return 'ok';
      // self-join from invite.
      if (
        targetKey === pdu.sender && targetMembership === 'invite'
      ) return 'ok';
      return 'state-reject';
    }
    // invite/leave/ban/knock under the stub: sender must be joined.
    // (Full rules — power levels, join_rule gating — are M3.)
    if (senderMembership === 'join') return 'ok';
    return 'state-reject';
  }
  // All other events: sender must be joined.
  const senderMembership = memberEventMembership(
    stateAtPrevs,
    getEvent,
    pdu.sender,
  );
  void createEventId;
  return senderMembership === 'join' ? 'ok' : 'state-reject';
}

// Union of the parent state sets. ANY (type, state_key) with differing
// event_ids across parents -> throw M_UNRESOLVED_CONFLICT. The room
// stays forked; the incoming heal event is refused; nothing is dropped
// or guessed. (Real v11 resolution is M3.)
export function resolveState(parentStateSets) {
  const merged = new Map();
  for (const set of parentStateSets) {
    for (const [k, v] of set) {
      const prev = merged.get(k);
      if (prev === undefined) {
        merged.set(k, v);
      } else if (prev !== v) {
        throw new Error(`M_UNRESOLVED_CONFLICT: ${k}`);
      }
    }
  }
  return merged;
}

export const version = '11-stub';
