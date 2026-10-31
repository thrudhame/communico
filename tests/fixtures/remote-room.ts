// tests/fixtures/remote-room.ts — a spec-honest fake remote room: a
// signed PDU DAG on a "remote server" with /backfill, /state_ids and
// /event answers computed from the DAG. State maps are resolved with
// the REAL rulebook over the fake's own events, so the fake's answers
// always agree with what the room core computes.
import { canonicalJson } from '#engine/canonical.ts';
import { redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  type EventStore,
  getRulebook,
  type StateMap,
} from '#engine/rulebook/index.ts';
import { b64encodeStd } from '#engine/signing-primitives.js';
import {
  makeRemoteServer,
  remoteEvent,
  type RemoteServer,
} from '#tests/fixtures/remote.ts';

export type FakeRoom = {
  roomId: string;
  version: string;
  server: RemoteServer;
  creator: string;
  createId: string;
  powerLevelsId: string;
  tipId: string;
  events: Map<string, Pdu>;
  // the state AFTER each event (resolved with the real rulebook)
  afterOf: Map<string, StateMap>;
  // Author an event: prevs default to the tip, depth to max(prevs)+1,
  // auth_events to the rulebook's selection over the state before.
  addEvent(partial: {
    type: string;
    sender?: string;
    content?: Record<string, unknown>;
    state_key?: string;
    prev_events?: string[];
    auth_events?: string[];
    depth?: number;
    origin_server_ts?: number;
  }): Promise<Pdu>;
  // The /backfill answer shape: the `from` events and their ancestors,
  // newest first (depth descending), capped at limit (backfill.yaml).
  backfillPdus(from: string[], limit: number): Pdu[];
  // The /state_ids answer: the full state BEFORE the event plus the
  // auth chain of that state's events (events.yaml).
  stateIdsAt(at: string): { pduIds: string[]; authChainIds: string[] } | null;
  event(id: string): Pdu | null;
  // The /make_join answer: the resident's template for the user
  // (joins-v1.yaml) — unsigned, unhashed.
  makeJoinAnswer(userId: string): { roomVersion: string; event: Pdu };
  // The resident's send_join: counter-signs the join, answers the state
  // PRIOR to it plus the auth chain and the signed copy, and applies it
  // to the DAG (joins-v2.yaml).
  acceptSendJoin(
    join: Pdu,
    tamper?: (resp: { state: Pdu[]; authChain: Pdu[]; event: Pdu }) => void,
  ): Promise<{ state: Pdu[]; authChain: Pdu[]; event: Pdu }>;
};

function keyOf(type: string, stateKey: string): string {
  return type + '\0' + stateKey;
}

export async function makeFakeRoom(opts: {
  roomId: string;
  version?: string;
  server?: RemoteServer;
  creator?: string;
  joinRule?: string;
}): Promise<FakeRoom> {
  const version = opts.version ?? '11';
  const server = opts.server ?? await makeRemoteServer('remote.test');
  const creator = opts.creator ?? '@zoe:' + server.name;
  const rulebook = getRulebook(version);
  const events = new Map<string, Pdu>();
  const afterOf = new Map<string, StateMap>();

  const store: EventStore = {
    get: (id) => events.get(id),
    isRejected: () => false,
  };

  function resolveBefore(prevs: string[]): StateMap {
    const maps = prevs.map((prev) => {
      const map = afterOf.get(prev);
      if (map === undefined) throw new Error('fake room: unknown prev ' + prev);
      return map;
    });
    if (maps.length === 0) return new Map();
    if (maps.length === 1) return new Map(maps[0]);
    return rulebook.resolveState(maps, store);
  }

  let tip = '';
  async function add(partial: {
    type: string;
    sender?: string;
    content?: Record<string, unknown>;
    state_key?: string;
    prev_events?: string[];
    auth_events?: string[];
    depth?: number;
    origin_server_ts?: number;
  }): Promise<Pdu> {
    const prevs = partial.prev_events ?? (tip === '' ? [] : [tip]);
    const before = resolveBefore(prevs);
    const depth = partial.depth ??
      (prevs.length === 0
        ? 1
        : Math.max(...prevs.map((prev) => events.get(prev)!.depth)) + 1);
    const probe = {
      type: partial.type,
      sender: partial.sender ?? creator,
      state_key: partial.state_key,
      content: partial.content ?? {},
    } as Pdu;
    const pdu = await remoteEvent(opts.roomId, server, version, {
      type: partial.type,
      sender: partial.sender ?? creator,
      content: partial.content ?? {},
      ...(partial.state_key !== undefined
        ? { state_key: partial.state_key }
        : {}),
      prev_events: prevs,
      auth_events: partial.auth_events ??
        (prevs.length === 0 ? [] : rulebook.selectAuthEvents(probe, before)),
      depth,
      ...(partial.origin_server_ts !== undefined
        ? { origin_server_ts: partial.origin_server_ts }
        : {}),
    });
    const id = String(pdu.event_id);
    events.set(id, pdu);
    const after = new Map(before);
    if (pdu.state_key !== undefined) {
      after.set(keyOf(String(pdu.type), String(pdu.state_key)), id);
    }
    afterOf.set(id, after);
    tip = id;
    return pdu;
  }

  // The genesis: create, creator join, power levels, join rules,
  // history visibility (the local genesis fixture's shape).
  const create = await add({
    type: 'm.room.create',
    content: { room_version: version, creator },
    state_key: '',
    origin_server_ts: 1,
  });
  const join = await add({
    type: 'm.room.member',
    state_key: creator,
    content: { membership: 'join' },
    origin_server_ts: 2,
  });
  const pl = await add({
    type: 'm.room.power_levels',
    state_key: '',
    content: {
      ban: 50,
      events: {},
      events_default: 0,
      invite: 0,
      kick: 50,
      redact: 50,
      state_default: 50,
      users: { [creator]: 100 },
      users_default: 0,
      notifications: { room: 50 },
    },
    origin_server_ts: 3,
  });
  await add({
    type: 'm.room.join_rules',
    state_key: '',
    content: { join_rule: opts.joinRule ?? 'public' },
    origin_server_ts: 4,
  });
  await add({
    type: 'm.room.history_visibility',
    state_key: '',
    content: { history_visibility: 'shared' },
    origin_server_ts: 5,
  });

  function authChainClosure(seeds: readonly string[]): string[] {
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const pdu = events.get(id);
      if (pdu === undefined) continue;
      queue.push(...(pdu.auth_events ?? []));
    }
    return [...seen].sort();
  }

  const room: FakeRoom = {
    roomId: opts.roomId,
    version,
    server,
    creator,
    createId: String(create.event_id),
    powerLevelsId: String(pl.event_id),
    get tipId() {
      return tip;
    },
    events,
    afterOf,
    addEvent: add,
    backfillPdus(from, limit) {
      const ancestors = new Set<string>();
      const queue = [...from];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (ancestors.has(id)) continue;
        ancestors.add(id);
        const pdu = events.get(id);
        if (pdu === undefined) continue;
        queue.push(...(pdu.prev_events ?? []));
      }
      return [...ancestors]
        .filter((id) => events.has(id))
        .sort((a, b) => {
          const da = events.get(a)!.depth;
          const db = events.get(b)!.depth;
          if (da !== db) return db - da; // newest first
          return a < b ? -1 : 1;
        })
        .slice(0, limit)
        .map((id) => events.get(id)!);
    },
    stateIdsAt(at) {
      const pdu = events.get(at);
      if (pdu === undefined) return null;
      const before = resolveBefore(pdu.prev_events ?? []);
      const pduIds = [...before.values()].sort();
      return {
        pduIds,
        authChainIds: authChainClosure(pduIds),
      };
    },
    event(id) {
      return events.get(id) ?? null;
    },
    makeJoinAnswer(userId) {
      const before = resolveBefore([tip]);
      const probe = {
        type: 'm.room.member',
        sender: userId,
        state_key: userId,
        content: { membership: 'join' },
      } as unknown as Pdu;
      return {
        roomVersion: version,
        event: {
          type: 'm.room.member',
          state_key: userId,
          sender: userId,
          room_id: opts.roomId,
          content: { membership: 'join' },
          prev_events: [tip],
          auth_events: rulebook.selectAuthEvents(probe, before),
          depth: events.get(tip)!.depth + 1,
          origin_server_ts: Date.now(),
        } as unknown as Pdu,
      };
    },
    async acceptSendJoin(join, tamper) {
      // the state PRIOR to the join (joins-v2.yaml) plus its auth chain
      const before = resolveBefore(join.prev_events ?? []);
      const state = [...before.values()].map((id) => events.get(id)!);
      const authChain = authChainClosure([
        ...before.values(),
        ...(join.auth_events ?? []),
      ]).map((id) => events.get(id)!);
      // counter-sign: the resident vouches for the joiner's event
      const counterSigned = structuredClone(join) as Pdu;
      const redacted = redact(
        counterSigned as unknown as Record<string, unknown>,
        version,
      );
      delete redacted.event_id;
      delete redacted.signatures;
      const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        server.kp.privateKey,
        new TextEncoder().encode(canonicalJson(redacted)),
      );
      counterSigned.signatures = {
        ...(counterSigned.signatures ?? {}),
        [server.name]: { [server.keyId]: b64encodeStd(new Uint8Array(sig)) },
      };
      const resp = { state, authChain, event: counterSigned };
      if (tamper !== undefined) tamper(resp);
      // apply to the DAG
      const id = String(counterSigned.event_id);
      events.set(id, counterSigned);
      const after = new Map(before);
      if (counterSigned.state_key !== undefined) {
        after.set(
          keyOf(String(counterSigned.type), String(counterSigned.state_key)),
          id,
        );
      }
      afterOf.set(id, after);
      tip = id;
      return resp;
    },
  };
  void join;
  return room;
}

// A message on the fake room (the common case).
export function fakeMessage(
  room: FakeRoom,
  body: string,
  partial: {
    sender?: string;
    prev_events?: string[];
    depth?: number;
    origin_server_ts?: number;
  } = {},
): Promise<Pdu> {
  return room.addEvent({
    type: 'm.room.message',
    sender: partial.sender ?? room.creator,
    content: { msgtype: 'm.text', body },
    ...(partial.prev_events !== undefined
      ? { prev_events: partial.prev_events }
      : {}),
    ...(partial.depth !== undefined ? { depth: partial.depth } : {}),
    ...(partial.origin_server_ts !== undefined
      ? { origin_server_ts: partial.origin_server_ts }
      : {}),
  });
}
