// tests/rulebook/fixtures.ts — shared fixtures for the rulebook corpus:
// hand-built PDUs, a small in-memory EventStore, the genesis room and the
// banned/restricted variants. No Deno.test registers here — a fixture
// module imported by the corpus files (a test file importing another test
// file would register that file's tests under the importer).
import type { EventStore, Pdu, StateMap } from '#engine/rulebook/types.ts';
import { stateKeyOf } from '#engine/rulebook/types.ts';

let seq = 0;
export function mkPdu(
  over: Partial<Pdu> & { type: string; sender: string },
  stateKey?: string | null,
): Pdu {
  seq++;
  return {
    room_id: '!r:localhost',
    content: {},
    prev_events: [],
    auth_events: [],
    depth: 2,
    origin_server_ts: 1000 + seq,
    hashes: { sha256: 'h' + seq },
    signatures: {},
    ...over,
    ...(stateKey === undefined
      ? {}
      : stateKey === null
      ? {}
      : { state_key: stateKey }),
  };
}

export class MemStore implements EventStore {
  events: Map<string, Pdu>;
  rejected: Set<string>;
  constructor(
    events: Map<string, Pdu> = new Map(),
    rejected: Set<string> = new Set(),
  ) {
    this.events = events;
    this.rejected = rejected;
  }
  static from(events: Pdu[], rejected: string[] = []): MemStore {
    const m = new Map<string, Pdu>();
    for (const e of events) if (e.event_id) m.set(e.event_id, e);
    return new MemStore(m, new Set(rejected));
  }
  get(id: string): Pdu | undefined {
    return this.events.get(id);
  }
  isRejected(id: string): boolean {
    return this.rejected.has(id);
  }
}

export function put(
  id: string,
  type: string,
  stateKey: string,
): [string, string] {
  return [stateKeyOf(type, stateKey), id];
}

export function stateMapOf(...entries: [string, string][]): StateMap {
  return new Map(entries);
}

// Genesis pieces reused by many rows.

export const CREATE_ID = '$create';
export const PL_ID = '$pl';
export const JOIN_DEV_ID = '$join_dev';
export const JOIN_ALICE_ID = '$join_alice';
export const JOIN_BOB_ID = '$join_bob';
export const JR_INVITE_ID = '$jr_invite';

export function genesisEvents(): Pdu[] {
  const create = mkPdu({
    type: 'm.room.create',
    sender: '@dev:localhost',
    content: { room_version: '11' },
    depth: 1,
    event_id: CREATE_ID,
  }, '');
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: {
        '@dev:localhost': 100,
        '@alice:localhost': 50,
        '@bob:localhost': 50,
      },
      users_default: 0,
      state_default: 50,
      events_default: 0,
      invite: 0,
      kick: 50,
      ban: 50,
      redact: 50,
    },
    auth_events: [CREATE_ID, JOIN_DEV_ID],
    event_id: PL_ID,
  }, '');
  const joinDev = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID],
    event_id: JOIN_DEV_ID,
  }, '@dev:localhost');
  const jr = mkPdu({
    type: 'm.room.join_rules',
    sender: '@dev:localhost',
    content: { join_rule: 'invite' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
    event_id: JR_INVITE_ID,
  }, '');
  const joinAlice = mkPdu({
    type: 'm.room.member',
    sender: '@alice:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, JOIN_ALICE_ID],
    event_id: JOIN_ALICE_ID,
  }, '@alice:localhost');
  const joinBob = mkPdu({
    type: 'm.room.member',
    sender: '@bob:localhost',
    content: { membership: 'join' },
    auth_events: [CREATE_ID, PL_ID, JR_INVITE_ID, JOIN_BOB_ID],
    event_id: JOIN_BOB_ID,
  }, '@bob:localhost');
  return [create, pl, joinDev, jr, joinAlice, joinBob];
}

export function genesisState(): StateMap {
  return new Map([
    put(CREATE_ID, 'm.room.create', ''),
    put(PL_ID, 'm.room.power_levels', ''),
    put(JOIN_DEV_ID, 'm.room.member', '@dev:localhost'),
    put(JR_INVITE_ID, 'm.room.join_rules', ''),
    put(JOIN_ALICE_ID, 'm.room.member', '@alice:localhost'),
    put(JOIN_BOB_ID, 'm.room.member', '@bob:localhost'),
  ]);
}

export const DEFAULT_AUTH = [CREATE_ID, PL_ID, JOIN_DEV_ID];

// Variant fixtures over the genesis set.

export function stateWithBannedBob(): StateMap {
  const s = genesisState();
  s.set(stateKeyOf('m.room.member', '@bob:localhost'), '$ban_bob');
  return s;
}

export function storeWithBannedBob(): MemStore {
  const banBob = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
    event_id: '$ban_bob',
  }, '@bob:localhost');
  return MemStore.from([...genesisEvents(), banBob]);
}

export function restrictedState(): StateMap {
  const s = genesisState();
  s.set(stateKeyOf('m.room.join_rules', ''), '$jr_restricted');
  // invite level 10: javus users below it cannot authorise joins
  s.set(stateKeyOf('m.room.power_levels', ''), '$pl_restricted');
  return s;
}

export function restrictedStore(): MemStore {
  const jr = mkPdu({
    type: 'm.room.join_rules',
    sender: '@dev:localhost',
    content: { join_rule: 'restricted' },
    auth_events: [CREATE_ID, PL_ID, JOIN_DEV_ID],
    event_id: '$jr_restricted',
  }, '');
  const pl = mkPdu({
    type: 'm.room.power_levels',
    sender: '@dev:localhost',
    content: {
      users: { '@dev:localhost': 100, '@alice:localhost': 50 },
      users_default: 0,
      invite: 10,
      kick: 50,
      ban: 50,
      redact: 50,
    },
    auth_events: [CREATE_ID, JOIN_DEV_ID],
    event_id: '$pl_restricted',
  }, '');
  return MemStore.from([...genesisEvents(), jr, pl]);
}
