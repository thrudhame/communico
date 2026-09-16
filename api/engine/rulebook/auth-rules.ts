// api/engine/rulebook/auth-rules.ts — the ten v11 authorization rules
// (plan §3a): one function per numbered rule, each carrying its spec
// number in a comment and in the returned `rule`. Spec tag v1.16,
// content/rooms/v11.md:113-260 (rules), 262-271 (unban note); definitions
// from content/server-server-api.md:487-508.
//
// Rules 1-2 are state-independent (they read the event's own auth_events
// via the EventStore — S8 check 4, server-server-api.md:473-474). Rules
// 3-10 are state-dependent (S8 check 5, server-server-api.md:475-476).
import {
  namedLevel,
  type ParsedPowerLevels,
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from './power-levels.ts';
import {
  type EventStore,
  type Pdu,
  type RoomVersionSpec,
  stateKeyOf,
  type StateMap,
  type Verdict,
} from './types.ts';

const reject = (rule: string, reason: string): Verdict => ({
  ok: false,
  rule,
  reason,
});
const allow = (rule: string): Verdict => ({ ok: true, rule });

export interface AuthCtx {
  state: StateMap;
  store: EventStore;
  // registry knowledge for rule 1.3 ("a recognised version")
  recognisedVersions: readonly string[];
}

function domainOf(id: string): string {
  // "the domain of the room_id / sender" — everything after the first ':'
  const i = id.indexOf(':');
  return i === -1 ? id : id.slice(i + 1);
}

function membershipOf(ctx: AuthCtx, userId: string): string | undefined {
  const id = ctx.state.get(stateKeyOf('m.room.member', userId));
  if (id === undefined) return undefined;
  const ev = ctx.store.get(id);
  const m = ev?.content?.membership;
  return typeof m === 'string' ? m : undefined;
}

function plEventOf(ctx: AuthCtx): Pdu | null {
  const id = ctx.state.get(stateKeyOf('m.room.power_levels', ''));
  if (id === undefined) return null;
  return ctx.store.get(id) ?? null;
}

function createEventOf(ctx: AuthCtx): Pdu | null {
  const id = ctx.state.get(stateKeyOf('m.room.create', ''));
  if (id === undefined) return null;
  return ctx.store.get(id) ?? null;
}

function joinRuleOf(ctx: AuthCtx): string | undefined {
  const id = ctx.state.get(stateKeyOf('m.room.join_rules', ''));
  if (id === undefined) return undefined;
  const j = ctx.store.get(id)?.content?.join_rule;
  return typeof j === 'string' ? j : undefined;
}

// Rule 1 (v11.md:115-122) — type is m.room.create.
function rule1(pdu: Pdu, recognisedVersions: readonly string[]): Verdict {
  // 1.1: if it has any prev_events, reject.
  if ((pdu.prev_events ?? []).length > 0) {
    return reject('1.1', 'm.room.create with prev_events');
  }
  // 1.2: the domain of the room_id must match the domain of the sender.
  if (domainOf(pdu.room_id) !== domainOf(pdu.sender)) {
    return reject('1.2', 'room_id domain does not match sender domain');
  }
  // 1.3: if content.room_version is present and is not a recognised
  // version, reject.
  const rv = pdu.content?.room_version;
  if (rv !== undefined && !recognisedVersions.includes(String(rv))) {
    return reject('1.3', 'unrecognised room_version');
  }
  // 1.4: otherwise, allow.
  return allow('2');
}

// The (type, state_key) pairs the auth-events selection algorithm permits
// (server-server-api.md:528-554 — auth events selection; the create clause
// is version-gated via spec.createInAuthEvents).
function selectionPairs(pdu: Pdu, spec: RoomVersionSpec): Set<string> {
  const pairs = new Set<string>();
  if (spec.createInAuthEvents) pairs.add(stateKeyOf('m.room.create', ''));
  pairs.add(stateKeyOf('m.room.power_levels', ''));
  pairs.add(stateKeyOf('m.room.member', pdu.sender));
  if (pdu.type === 'm.room.member') {
    const target = pdu.state_key ?? '';
    const membership = pdu.content?.membership;
    if (target !== pdu.sender) {
      pairs.add(stateKeyOf('m.room.member', target));
    }
    if (
      membership === 'join' || membership === 'invite' || membership === 'knock'
    ) {
      pairs.add(stateKeyOf('m.room.join_rules', ''));
    }
    if (
      membership === 'invite' &&
      typeof (pdu.content as Record<string, unknown>)?.third_party_invite ===
        'object'
    ) {
      const tpi = (pdu.content as Record<string, unknown>)
        .third_party_invite as {
          signed?: { token?: unknown };
        };
      if (typeof tpi.signed?.token === 'string') {
        pairs.add(stateKeyOf('m.room.third_party_invite', tpi.signed.token));
      }
    }
    const viaUser = pdu.content?.join_authorised_via_users_server;
    if (typeof viaUser === 'string' && viaUser.length > 0) {
      pairs.add(stateKeyOf('m.room.member', viaUser));
    }
  }
  return pairs;
}

// Rule 2 (v11.md:123-137) — considering the event's auth_events.
function rule2(pdu: Pdu, store: EventStore, spec: RoomVersionSpec): Verdict {
  const declared = pdu.auth_events ?? [];
  // 2.1: duplicate entries for a (type, state_key) pair -> reject.
  const seen = new Set<string>();
  for (const id of declared) {
    const ev = store.get(id);
    if (!ev) continue; // unresolvable ids handled at 2.2
    const k = stateKeyOf(ev.type, ev.state_key ?? '');
    if (seen.has(k)) {
      return reject('2.1', `duplicate auth entry for ${k}`);
    }
    seen.add(k);
  }
  // 2.2: entries whose (type, state_key) don't match the auth events
  // selection algorithm -> reject (server-server-api.md:528-554).
  const pairs = selectionPairs(pdu, spec);
  for (const id of declared) {
    const ev = store.get(id);
    if (!ev) {
      return reject('2.2', `auth entry ${id} cannot be resolved`);
    }
    if (!pairs.has(stateKeyOf(ev.type, ev.state_key ?? ''))) {
      return reject(
        '2.2',
        `auth entry ${id} (${ev.type}) is outside the selection set`,
      );
    }
  }
  // 2.3: entries rejected under the receipt checks -> reject.
  for (const id of declared) {
    if (store.isRejected(id)) {
      return reject('2.3', `auth entry ${id} was rejected`);
    }
  }
  // 2.4: no m.room.create among the entries -> reject (v11.md:131,135).
  if (!declared.some((id) => store.get(id)?.type === 'm.room.create')) {
    return reject('2.4', 'no m.room.create among auth_events');
  }
  // 2.5: any entry with a foreign room_id -> reject (v11.md:136-137,
  // changed-in v1.16; flag-gated per plan §3b).
  if (spec.authEventsSameRoom) {
    for (const id of declared) {
      const ev = store.get(id);
      if (ev && ev.room_id !== pdu.room_id) {
        return reject('2.5', `auth entry ${id} belongs to another room`);
      }
    }
  }
  return allow('1.4');
}

// Rules 1-2, evaluated in spec order (S8 check 4: "authorization rules
// based on the event's auth events").
export function checkAuthChain(
  pdu: Pdu,
  store: EventStore,
  recognisedVersions: readonly string[],
  spec: RoomVersionSpec,
): Verdict {
  // Rule 1 is terminal for m.room.create.
  if (pdu.type === 'm.room.create') return rule1(pdu, recognisedVersions);
  const v2 = rule2(pdu, store, spec);
  return v2.ok ? allow('2') : v2;
}

// Rules 3-10 against a state map (S8 check 5). One function per numbered
// rule; the cascade terminates at the first verdict. Member events are
// TERMINAL at rule 4 (every membership arm ends in allow/reject:
// v11.md:148-217); create events terminate at rule 1; third_party_invite
// events terminate at rule 6.
export function checkAuthAgainstState(
  pdu: Pdu,
  state: StateMap,
  store: EventStore,
  spec: RoomVersionSpec,
): Verdict {
  // Rule 1 is terminal for m.room.create — rules 3-10 never apply to it
  // (a create that reached rule 3 in the cascade already passed rule 1).
  if (pdu.type === 'm.room.create') return allow('1.4');
  const ctx: AuthCtx = { state, store, recognisedVersions: [] };
  const plEvent = plEventOf(ctx);
  const createEvent = createEventOf(ctx);
  const senderLevel = userPowerLevel(pdu.sender, plEvent, createEvent, spec);

  // Rule 3 (v11.md:138-140): m.federate=false + foreign sender domain.
  const v3 = rule3(pdu, ctx);
  if (!v3.ok) return v3;

  // Rule 4 (v11.md:141-217) — terminal for m.room.member.
  if (pdu.type === 'm.room.member') {
    return rule4(pdu, ctx, spec, plEvent, createEvent, senderLevel);
  }

  // Rule 5 (v11.md:218): the sender's current membership must be join.
  if (membershipOf(ctx, pdu.sender) !== 'join') {
    return reject('5', 'sender is not joined');
  }

  // Rule 6 (v11.md:219-221) — terminal for m.room.third_party_invite.
  if (pdu.type === 'm.room.third_party_invite') {
    const inviteLevel = namedLevel('invite', parsedPl(plEvent));
    if (senderLevel >= inviteLevel) return allow('6.1');
    return reject('6.1', 'sender below the invite level');
  }

  // Rule 7 (v11.md:222-223): required power level.
  const required = requiredLevel(
    pdu.type,
    pdu.state_key,
    parsedPl(plEvent),
  );
  if (required > senderLevel) {
    return reject(
      '7',
      `required level ${required} > sender level ${senderLevel}`,
    );
  }

  // Rule 8 (v11.md:224-225): a state_key starting with @ must match sender.
  if (
    pdu.state_key !== undefined && pdu.state_key.startsWith('@') &&
    pdu.state_key !== pdu.sender
  ) {
    return reject('8', 'state_key starting with @ does not match sender');
  }

  // Rule 9 (v11.md:226-259) — m.room.power_levels specifics.
  if (pdu.type === 'm.room.power_levels') {
    return rule9(pdu, spec, plEvent, senderLevel);
  }

  // Rule 10 (v11.md:260): otherwise, allow.
  return allow('10');
}

function parsedPl(plEvent: Pdu | null): ParsedPowerLevels | null {
  if (!plEvent) return null;
  const parsed = parsePowerLevels(plEvent.content, {
    enforceIntPowerLevels: false,
  });
  return parsed.ok ? parsed.pl : null;
}

// Rule 3 (v11.md:138-140).
function rule3(pdu: Pdu, ctx: AuthCtx): Verdict {
  const create = createEventOf(ctx);
  if (!create) return allow('3'); // rule 2.4 already rejected missing creates
  const federate = create.content?.['m.federate'];
  if (federate === false && domainOf(pdu.sender) !== domainOf(create.sender)) {
    return reject('3', 'room is not federated and sender domain differs');
  }
  return allow('3');
}

// Rule 4 (v11.md:141-217).
function rule4(
  pdu: Pdu,
  ctx: AuthCtx,
  spec: RoomVersionSpec,
  plEvent: Pdu | null,
  createEvent: Pdu | null,
  senderLevel: number,
): Verdict {
  const stateKey = pdu.state_key;
  const membership = pdu.content?.membership;

  // 4.1: no state_key, or no membership in content -> reject.
  if (stateKey === undefined || typeof membership !== 'string') {
    return reject('4.1', 'member event without state_key or membership');
  }
  const target = stateKey;
  const targetLevel = userPowerLevel(target, plEvent, createEvent, spec);

  // 4.2 (v11.md:144-147): join_authorised_via_users_server must be validly
  // signed by the authorising user's homeserver. The CRYPTOGRAPHIC check
  // lives in the signing layer (ingest verifies every signature entry);
  // here we verify the event carries a signature entry for that server.
  // Full cross-server key verification is federation (M5).
  const viaUser = pdu.content?.join_authorised_via_users_server;
  if (viaUser !== undefined && typeof viaUser === 'string') {
    const viaDomain = domainOf(viaUser);
    const sigs = pdu.signatures ?? {};
    if (!(viaDomain in sigs)) {
      return reject('4.2.1', 'no signature from the authorising server');
    }
  }

  const joinRule = joinRuleOf(ctx);
  const senderMembership = membershipOf(ctx, pdu.sender);

  if (membership === 'join') {
    // 4.3.1 (v11.md:149-151): the only previous event is the create and
    // the state_key is the create's sender (v1.16 wording) — allow.
    const createId = ctx.state.get(stateKeyOf('m.room.create', ''));
    if (
      (pdu.prev_events ?? []).length === 1 && createId !== undefined &&
      (pdu.prev_events ?? [])[0] === createId && createEvent &&
      target === createEvent.sender
    ) {
      return allow('4.3.1');
    }
    // 4.3.2: sender must match state_key.
    if (pdu.sender !== target) {
      return reject('4.3.2', 'join sender does not match state_key');
    }
    // 4.3.3: the sender is banned -> reject.
    if (senderMembership === 'ban') {
      return reject('4.3.3', 'sender is banned');
    }
    // 4.3.4: join_rule invite or knock: allow iff current membership is
    // invite or join.
    if (joinRule === 'invite' || (joinRule === 'knock' && spec.knockJoinRule)) {
      const cur = membershipOf(ctx, target);
      if (cur === 'invite' || cur === 'join') return allow('4.3.4');
    }
    // 4.3.5: join_rule restricted or knock_restricted.
    if (
      (joinRule === 'restricted' && spec.restrictedJoinRule) ||
      (joinRule === 'knock_restricted' && spec.knockRestrictedJoinRule)
    ) {
      const cur = membershipOf(ctx, target);
      // 4.3.5.1: current membership join or invite -> allow.
      if (cur === 'join' || cur === 'invite') return allow('4.3.5.1');
      // 4.3.5.2: the authorised user must have invite permission.
      const vu = pdu.content?.join_authorised_via_users_server;
      if (typeof vu !== 'string' || vu.length === 0) {
        return reject('4.3.5.2', 'no join_authorised_via_users_server');
      }
      const vuLevel = userPowerLevel(vu, plEvent, createEvent, spec);
      if (vuLevel < namedLevel('invite', parsedPl(plEvent))) {
        return reject('4.3.5.2', 'authorising user cannot invite');
      }
      // 4.3.5.3: otherwise, allow.
      return allow('4.3.5.3');
    }
    // 4.3.6: join_rule public -> allow.
    if (joinRule === 'public') return allow('4.3.6');
    // 4.3.7: otherwise, reject.
    return reject(
      '4.3.7',
      `join_rule ${String(joinRule)} does not permit join`,
    );
  }

  if (membership === 'invite') {
    // 4.4.1 (v11.md:165-182): third_party_invite chain.
    const tpi = pdu.content?.third_party_invite;
    if (tpi !== undefined && typeof tpi === 'object' && tpi !== null) {
      const t = tpi as {
        signed?: { mxid?: unknown; token?: unknown; signatures?: unknown };
      };
      // 4.4.1.1: target user banned -> reject.
      if (membershipOf(ctx, target) === 'ban') {
        return reject('4.4.1.1', 'target user is banned');
      }
      // 4.4.1.2: no signed property -> reject.
      if (
        t.signed === undefined || typeof t.signed !== 'object' ||
        t.signed === null
      ) {
        return reject('4.4.1.2', 'third_party_invite without signed');
      }
      // 4.4.1.3: signed without mxid and token -> reject.
      if (
        typeof t.signed.mxid !== 'string' || typeof t.signed.token !== 'string'
      ) {
        return reject('4.4.1.3', 'signed lacks mxid/token');
      }
      // 4.4.1.4: mxid must match state_key.
      if (t.signed.mxid !== target) {
        return reject('4.4.1.4', 'mxid does not match state_key');
      }
      // 4.4.1.5: the token's m.room.third_party_invite event must be in
      // the current state.
      const tpiId = ctx.state.get(
        stateKeyOf('m.room.third_party_invite', t.signed.token),
      );
      const tpiEvent = tpiId === undefined ? undefined : ctx.store.get(tpiId);
      if (!tpiEvent) {
        return reject('4.4.1.5', 'no m.room.third_party_invite for the token');
      }
      // 4.4.1.6: sender must match the third_party_invite's sender.
      if (pdu.sender !== tpiEvent.sender) {
        return reject(
          '4.4.1.6',
          'sender does not match the third_party_invite sender',
        );
      }
      // 4.4.1.7: any signature in signed matching any public key of the
      // third_party_invite event (public_key / public_keys) -> allow.
      const sigValues: string[] = [];
      const signed = t.signed as {
        signatures?: Record<string, Record<string, string>>;
      };
      if (signed.signatures && typeof signed.signatures === 'object') {
        for (const keys of Object.values(signed.signatures)) {
          if (keys && typeof keys === 'object') {
            for (const v of Object.values(keys)) {
              if (typeof v === 'string') sigValues.push(v);
            }
          }
        }
      }
      const publicKeys: string[] = [];
      if (typeof tpiEvent.content?.public_key === 'string') {
        publicKeys.push(tpiEvent.content.public_key);
      }
      if (Array.isArray(tpiEvent.content?.public_keys)) {
        for (const k of tpiEvent.content.public_keys) {
          if (typeof k === 'string') publicKeys.push(k);
        }
      }
      if (sigValues.some((s) => publicKeys.includes(s))) {
        return allow('4.4.1.7');
      }
      // 4.4.1.8: otherwise, reject.
      return reject(
        '4.4.1.8',
        'no signature matches a third_party_invite public key',
      );
    }
    // 4.4.2: the sender's current membership must be join.
    if (senderMembership !== 'join') {
      return reject('4.4.2', 'sender is not joined');
    }
    // 4.4.3: target already join or ban -> reject.
    const cur = membershipOf(ctx, target);
    if (cur === 'join' || cur === 'ban') {
      return reject('4.4.3', 'target is joined or banned');
    }
    // 4.4.4: sender power >= invite level -> allow.
    if (senderLevel >= namedLevel('invite', parsedPl(plEvent))) {
      return allow('4.4.4');
    }
    // 4.4.5: otherwise, reject.
    return reject('4.4.5', 'sender below the invite level');
  }

  if (membership === 'leave') {
    // 4.5.1 (v11.md:191-193): self-leave allowed iff current membership is
    // invite, join or knock.
    if (pdu.sender === target) {
      const cur = membershipOf(ctx, target);
      if (cur === 'invite' || cur === 'join' || cur === 'knock') {
        return allow('4.5.1');
      }
      return reject('4.5.1', 'self-leave without invite/join/knock membership');
    }
    // 4.5.2: the sender's current membership must be join.
    if (senderMembership !== 'join') {
      return reject('4.5.2', 'sender is not joined');
    }
    // 4.5.3: target banned and sender below the ban level -> reject.
    const banLevel = namedLevel('ban', parsedPl(plEvent));
    if (membershipOf(ctx, target) === 'ban' && senderLevel < banLevel) {
      return reject('4.5.3', 'sender below the ban level to unban');
    }
    // 4.5.4: sender >= kick level and target < sender -> allow.
    if (
      senderLevel >= namedLevel('kick', parsedPl(plEvent)) &&
      targetLevel < senderLevel
    ) {
      return allow('4.5.4');
    }
    // 4.5.5: otherwise, reject.
    return reject('4.5.5', 'kick conditions not met');
  }

  if (membership === 'ban') {
    // 4.6.1: the sender's current membership must be join.
    if (senderMembership !== 'join') {
      return reject('4.6.1', 'sender is not joined');
    }
    // 4.6.2: sender >= ban level and target < sender -> allow.
    if (
      senderLevel >= namedLevel('ban', parsedPl(plEvent)) &&
      targetLevel < senderLevel
    ) {
      return allow('4.6.2');
    }
    // 4.6.3: otherwise, reject.
    return reject('4.6.3', 'ban conditions not met');
  }

  if (membership === 'knock') {
    // 4.7.1: join_rule must be knock or knock_restricted.
    if (
      !(joinRule === 'knock' && spec.knockJoinRule) &&
      !(joinRule === 'knock_restricted' && spec.knockRestrictedJoinRule)
    ) {
      return reject(
        '4.7.1',
        `join_rule ${String(joinRule)} does not accept knocks`,
      );
    }
    // 4.7.2: sender must match state_key.
    if (pdu.sender !== target) {
      return reject('4.7.2', 'knock sender does not match state_key');
    }
    // 4.7.3: sender's membership NOT in {ban, invite, join} -> allow.
    if (!['ban', 'invite', 'join'].includes(senderMembership ?? '')) {
      return allow('4.7.3');
    }
    // 4.7.4: otherwise, reject.
    return reject('4.7.4', 'sender is already ban/invite/join');
  }

  // 4.8: unknown membership -> reject.
  return reject('4.8', 'unknown membership');
}

// Rule 9 (v11.md:226-259) — m.room.power_levels deltas vs the previous PL
// event. 9.1-9.3 structure via parsePowerLevels (integer-only: v10.md
// 221-228, flagged); 9.4 no previous PL event -> allow; 9.5-9.9
// alteration checks; 9.10 otherwise allow.
function rule9(
  pdu: Pdu,
  spec: RoomVersionSpec,
  plEvent: Pdu | null,
  senderLevel: number,
): Verdict {
  // 9.1-9.3: structural checks (rule numbers carried by the parser).
  const parsed = parsePowerLevels(pdu.content, spec);
  if (!parsed.ok) {
    return reject(parsed.rule, 'malformed m.room.power_levels content');
  }

  // 9.4: no previous m.room.power_levels event -> allow.
  if (!plEvent) return allow('9.4');

  const prevParsed = parsePowerLevels(plEvent.content, spec);
  const prev: ParsedPowerLevels = prevParsed.ok
    ? prevParsed.pl
    : { users: {}, events: {}, notifications: {} };
  const next = parsed.pl;

  // 9.5 (v11.md:237-243): the scalar keys — added, changed or removed.
  const scalarKeys = [
    'users_default',
    'events_default',
    'state_default',
    'ban',
    'redact',
    'kick',
    'invite',
  ] as const;
  for (const k of scalarKeys) {
    const cur = (prev as unknown as Record<string, number | undefined>)[k];
    const now = (next as unknown as Record<string, number | undefined>)[k];
    if (cur === now) continue;
    // removed or changed: the current value must not exceed the sender's level
    if (cur !== undefined && cur > senderLevel) {
      return reject('9.5.1', `${k} currently ${cur} above sender level`);
    }
    // added or changed: the new value must not exceed the sender's level
    if (now !== undefined && now > senderLevel) {
      return reject('9.5.2', `${k} set to ${now} above sender level`);
    }
  }

  // 9.6/9.7 (v11.md:244-251): events/notifications entries.
  for (const mapName of ['events', 'notifications'] as const) {
    const oldMap = prev[mapName] ?? {};
    const newMap = next[mapName] ?? {};
    const keys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
    for (const k of keys) {
      const was = oldMap[k];
      const now = newMap[k];
      if (was === now) continue;
      // changed or removed: the current value must not be greater
      if (was !== undefined && was > senderLevel) {
        return reject(
          '9.6.1',
          `${mapName}.${k} currently ${was} above sender level`,
        );
      }
      // added or changed: the new value must not be greater
      if (now !== undefined && now > senderLevel) {
        return reject(
          '9.7.1',
          `${mapName}.${k} set to ${now} above sender level`,
        );
      }
    }
  }

  // 9.8/9.9 (v11.md:252-258): users entries (9.8 skips the sender's own).
  const allUsers = new Set([
    ...Object.keys(prev.users),
    ...Object.keys(next.users),
  ]);
  for (const u of allUsers) {
    const was = prev.users[u];
    const now = next.users[u];
    if (was === now) continue;
    // changed or removed, other than the sender's own entry: the current
    // value must be below the sender's level
    if (u !== pdu.sender && was !== undefined && was >= senderLevel) {
      return reject(
        '9.8.1',
        `users.${u} currently ${was} at/above sender level`,
      );
    }
    // added or changed: the new value must not exceed the sender's level
    if (now !== undefined && now > senderLevel) {
      return reject('9.9.1', `users.${u} set to ${now} above sender level`);
    }
  }

  // 9.10: otherwise, allow.
  return allow('9.10');
}
