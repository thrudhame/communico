// tests/federation/fake-room.ts — a remote room model held by a fake
// server: builds valid signed PDUs with the fake's key (ids/hashes via
// the engine's eventIdFor/contentHashOf/signJson), tracks state and
// extremities, and answers the room endpoints the native suite drives —
// the shape Complement's federation.Room gives its tests, so our flows
// run without Docker.
import { eventIdFor } from '#engine/eventid.ts';
import {
  b64encodeStd,
  contentHashOf,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';
import type { Pdu } from '#engine/pdu.ts';

export type FakeRoomServer = {
  name: string;
  keyId: string;
  kp: CryptoKeyPair;
};

export async function makeRoomServer(name: string): Promise<FakeRoomServer> {
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  return { name, keyId: 'ed25519:1', kp };
}

export type FakeRoom = {
  roomId: string;
  version: string;
  server: FakeRoomServer;
  events: Map<string, Pdu>;
  addEvent: (
    partial: {
      type: string;
      sender: string;
      content?: Record<string, unknown>;
      state_key?: string;
      prev_events?: string[];
      auth_events?: string[];
      depth?: number;
      origin_server_ts?: number;
    },
  ) => Promise<Pdu>;
  extremityIds: () => string[];
  currentState: () => Pdu[];
  stateIds: (
    eventId: string,
  ) => { pdu_ids: string[]; auth_chain_ids: string[] };
  event: (id: string) => Pdu | null;
  backfill: (v: string[], limit: number) => Pdu[];
  missingEvents: (
    earliest: string[],
    latest: string[],
    limit: number,
  ) => Pdu[];
  makeJoinTemplate: (userId: string) => Record<string, unknown>;
  acceptSendJoin: (join: Pdu) => Promise<Record<string, unknown>>;
  makeLeaveTemplate: (userId: string) => Record<string, unknown>;
  acceptSendLeave: (leave: Pdu) => Promise<void>;
  signInvite: (invite: Pdu) => Promise<Pdu>;
  authChainOf: (eventIds: string[]) => Set<string>;
  wire: (pdu: Pdu) => Record<string, unknown>;
};

const PL_DEFAULTS = {
  ban: 50,
  events: {},
  events_default: 0,
  invite: 0,
  kick: 50,
  redact: 50,
  state_default: 50,
  users: {} as Record<string, number>,
  users_default: 0,
  notifications: { room: 50 },
};

export async function createFakeRoom(opts: {
  version: string;
  creator: string; // full MXID on the room's server
  server?: FakeRoomServer;
}): Promise<FakeRoom> {
  const server = opts.server ??
    (await makeRoomServer(domainOfUser(opts.creator)));
  const roomId = `!${crypto.randomUUID().slice(0, 18)}:${server.name}`;
  const events = new Map<string, Pdu>();
  const children = new Map<string, string[]>();
  const state = new Map<string, string>(); // (type\0state_key) -> eventId
  let maxDepth = 0;

  function domainOfUser(mxid: string): string {
    const at = mxid.indexOf(':');
    return at < 0 ? mxid : mxid.slice(at + 1);
  }

  function extremityIds(): string[] {
    const out: string[] = [];
    for (const id of events.keys()) {
      if (!(children.get(id)?.length ?? 0)) out.push(id);
    }
    return out;
  }

  function authChainOf(eventIds: string[]): Set<string> {
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const e = events.get(id);
      for (const a of e?.auth_events ?? []) walk(a);
    };
    for (const id of eventIds) walk(id);
    return seen;
  }

  function wire(pdu: Pdu): Record<string, unknown> {
    const out = { ...(pdu as unknown as Record<string, unknown>) };
    delete out.event_id;
    delete out.unsigned;
    return out;
  }

  async function sign(pdu: Pdu): Promise<Pdu> {
    // redact-then-sign (spec § hash_and_sign_event): the signature covers
    // the REDACTED form + hashes, so it verifies on redacted copies;
    // signatures are copied back to the full event
    const { redact } = await import('#engine/eventid.ts');
    const redacted = redact(
      pdu as unknown as Record<string, unknown>,
      opts.version,
    );
    await signJson(redacted, server.name, server.keyId, server.kp.privateKey);
    pdu.signatures = (redacted.signatures ?? {}) as Record<
      string,
      Record<string, string>
    >;
    return pdu;
  }

  async function addEvent(
    partial: {
      type: string;
      sender: string;
      content?: Record<string, unknown>;
      state_key?: string;
      prev_events?: string[];
      auth_events?: string[];
      depth?: number;
      origin_server_ts?: number;
    },
  ): Promise<Pdu> {
    const prevs = partial.prev_events ?? extremityIds();
    const depth = partial.depth ??
      (prevs.length === 0 ? 1 : Math.max(
        ...prevs.map((p) => Number(events.get(p)?.depth ?? 0)),
      ) + 1);
    // the fake's standard auth set (create + PL + the sender's member):
    // what the rulebook selects in a plain linear room; the receiver's
    // relaxed remote checks need rules 1–2 only.
    const stateEventIds = (t: string, k: string) => state.get(t + '' + k);
    const authEvents = partial.auth_events ?? [
      stateEventIds('m.room.create', ''),
      stateEventIds('m.room.power_levels', ''),
      stateEventIds('m.room.member', partial.sender),
    ].filter((x): x is string => typeof x === 'string');
    const pdu: Pdu = {
      type: partial.type,
      sender: partial.sender,
      room_id: roomId,
      content: (partial.content ?? {}) as Record<string, unknown>,
      prev_events: prevs,
      auth_events: authEvents,
      depth,
      origin_server_ts: partial.origin_server_ts ?? Date.now(),
      hashes: { sha256: '' },
      signatures: {},
    };
    if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
    // hash + id over the unsigned-less, signature-less form
    const {
      event_id: _dropId,
      signatures: _dropSig,
      hashes: _dropHash,
      ...forHash
    } = pdu as unknown as Record<string, unknown>;
    void _dropId, void _dropSig, void _dropHash;
    (pdu.hashes as { sha256: string }).sha256 = await contentHashOf(forHash);
    (pdu as unknown as Record<string, unknown>).event_id = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      opts.version,
    );
    await sign(pdu);
    // store + update the model
    const id = String(pdu.event_id);
    events.set(id, pdu);
    for (const p of prevs) {
      const kids = children.get(p) ?? [];
      kids.push(id);
      children.set(p, kids);
    }
    if (partial.state_key !== undefined) {
      state.set(partial.type + '' + partial.state_key, id);
    }
    if (depth > maxDepth) maxDepth = depth;
    return pdu;
  }

  function currentState(): Pdu[] {
    return [...state.values()].map((id) => events.get(id)!);
  }

  function stateIds(eventId: string): {
    pdu_ids: string[];
    auth_chain_ids: string[];
  } {
    // the state AT an event: fold its ancestry in depth order (the fake
    // room is linear enough for latest-wins per key)
    const chain = new Set<string>();
    const walk = (id: string) => {
      if (chain.has(id)) return;
      chain.add(id);
      for (const p of events.get(id)?.prev_events ?? []) walk(p);
    };
    walk(eventId);
    const ordered = [...chain]
      .map((id) => events.get(id)!)
      .sort((a, b) => a.depth - b.depth);
    const at = new Map<string, string>();
    for (const e of ordered) {
      if (e.state_key !== undefined) {
        at.set(e.type + '' + e.state_key, String(e.event_id));
      }
    }
    return {
      pdu_ids: [...at.values()],
      auth_chain_ids: [...authChainOf([...at.values()])],
    };
  }

  // genesis: create + creator join + power levels + public join rules +
  // shared visibility (so a remote joiner passes auth)
  const create = await addEvent({
    type: 'm.room.create',
    sender: opts.creator,
    state_key: '',
    content: { room_version: opts.version, creator: opts.creator },
    prev_events: [],
  });
  void create;
  await addEvent({
    type: 'm.room.member',
    sender: opts.creator,
    state_key: opts.creator,
    content: { membership: 'join' },
  });
  await addEvent({
    type: 'm.room.power_levels',
    sender: opts.creator,
    state_key: '',
    content: { ...PL_DEFAULTS, users: { [opts.creator]: 100 } },
  });
  await addEvent({
    type: 'm.room.join_rules',
    sender: opts.creator,
    state_key: '',
    content: { join_rule: 'public' },
  });
  await addEvent({
    type: 'm.room.history_visibility',
    sender: opts.creator,
    state_key: '',
    content: { history_visibility: 'shared' },
  });

  return {
    roomId,
    version: opts.version,
    server,
    events,
    addEvent,
    extremityIds,
    currentState,
    stateIds,
    event: (id) => events.get(id) ?? null,
    backfill: (v, limit) => {
      // walk prev_events back from v, breadth-first, newest-first,
      // INCLUDING v — capped at limit (backfill.yaml:19-70)
      const out: Pdu[] = [];
      const seen = new Set<string>();
      let frontier = [...v];
      while (frontier.length > 0 && out.length < limit) {
        const next: string[] = [];
        for (const id of frontier) {
          if (out.length >= limit) break;
          if (seen.has(id)) continue;
          seen.add(id);
          const e = events.get(id);
          if (!e) continue;
          out.push(e);
          next.push(...(e.prev_events ?? []));
        }
        frontier = next;
      }
      return out;
    },
    missingEvents: (earliest, latest, limit) => {
      // breadth-first back from latest_events, stopping at earliest and
      // at events we do not hold; FORWARD topological order
      const earliestSet = new Set(earliest);
      const out: Pdu[] = [];
      const seen = new Set<string>();
      let frontier = [...latest];
      while (frontier.length > 0 && out.length < limit) {
        const next: string[] = [];
        for (const id of frontier) {
          if (seen.has(id)) continue;
          seen.add(id);
          const e = events.get(id);
          if (!e) continue;
          if (!earliestSet.has(id) && id !== latest[0]) {
            // earliest events themselves are included in the walk stop
          }
          out.push(e);
          if (!earliestSet.has(id)) next.push(...(e.prev_events ?? []));
        }
        frontier = next;
      }
      return out.sort((a, b) => a.depth - b.depth);
    },
    makeJoinTemplate: (userId) => ({
      // the spec's wrapper (joins-v1.yaml): room_version + event
      room_version: opts.version,
      event: {
        type: 'm.room.member',
        state_key: userId,
        sender: userId,
        room_id: roomId,
        content: { membership: 'join' },
        prev_events: extremityIds(),
        auth_events: [
          state.get('m.room.create' + ''),
          state.get('m.room.power_levels' + ''),
        ].filter((x): x is string => typeof x === 'string'),
        depth: maxDepth + 1,
        origin: server.name,
        origin_server_ts: Date.now(),
      },
    }),
    acceptSendJoin: async (join) => {
      // v2 answer per joins-v2.yaml:160-220 with the fake's signature
      // added (SS:881-885); the join lands in the room — hashed first,
      // like any event the room serves
      const { event_id: _a, signatures: _b, hashes: _c, ...forHash } =
        join as unknown as Record<string, unknown>;
      void _a, void _b, void _c;
      join.hashes = { sha256: await contentHashOf(forHash) };
      const signed = await sign(join);
      const id = String(signed.event_id);
      events.set(id, signed);
      for (const p of signed.prev_events ?? []) {
        const kids = children.get(p) ?? [];
        kids.push(id);
        children.set(p, kids);
      }
      if (signed.state_key !== undefined) {
        state.set(signed.type + '' + signed.state_key, id);
      }
      const stateEvents = currentState();
      return {
        state: stateEvents.map(wire),
        auth_chain: [...authChainOf(stateEvents.map((e) => String(e.event_id)))]
          .map((id) => wire(events.get(id)!)),
        event: wire(signed),
        members_omitted: false,
        servers_in_room: [server.name],
      };
    },
    makeLeaveTemplate: (userId) => ({
      // the spec's wrapper (leaving-v1.yaml): room_version + event
      room_version: opts.version,
      event: {
        type: 'm.room.member',
        state_key: userId,
        sender: userId,
        room_id: roomId,
        content: { membership: 'leave' },
        prev_events: extremityIds(),
        auth_events: [
          state.get('m.room.create' + ''),
          state.get('m.room.power_levels' + ''),
          state.get('m.room.member' + userId),
        ].filter((x): x is string => typeof x === 'string'),
        depth: maxDepth + 1,
        origin: server.name,
        origin_server_ts: Date.now(),
      },
    }),
    acceptSendLeave: async (leave) => {
      const { event_id: _a, signatures: _b, hashes: _c, ...forHash } =
        leave as unknown as Record<string, unknown>;
      void _a, void _b, void _c;
      leave.hashes = { sha256: await contentHashOf(forHash) };
      const signed = await sign(leave);
      const id = String(signed.event_id);
      events.set(id, signed);
      for (const p of signed.prev_events ?? []) {
        const kids = children.get(p) ?? [];
        kids.push(id);
        children.set(p, kids);
      }
      if (signed.state_key !== undefined) {
        state.set(signed.type + '' + signed.state_key, id);
      }
    },
    signInvite: async (invite) => await sign(invite),
    authChainOf,
    wire,
  };
}

// the public half of a room server, for key documents
export async function publicKeyB64(server: FakeRoomServer): Promise<string> {
  return b64encodeStd(await exportPublicKeyRaw(server.kp.publicKey));
}
