// tests/fixtures/remote.ts — the remote-ingest fakes: a signing "remote
// server" (its own ed25519 key), a real-verification KeyResolver over a
// key registry, a scriptable Fetcher recording its calls, and a builder
// for signed remote PDUs (hash, reference-hash id, redact-then-sign —
// the shape the room core receives over federation).
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Fetcher, KeyResolver } from '#engine/room/deps.ts';
import {
  b64encodeStd,
  contentHashOf,
  generateSigningKeypair,
  verifyJson,
} from '#engine/signing-primitives.js';

export type RemoteServer = {
  name: string;
  keyId: string; // 'ed25519:1'
  kp: CryptoKeyPair;
  // The key document's validity floor (for enforceKeyValidity tests);
  // absent means never expiring.
  validUntilMs?: number;
};

export async function makeRemoteServer(
  name: string,
  opts: { validUntilMs?: number } = {},
): Promise<RemoteServer> {
  const kp = (await generateSigningKeypair()) as CryptoKeyPair;
  return { name, keyId: 'ed25519:1', kp, validUntilMs: opts.validUntilMs };
}

// A KeyResolver over a registry of RemoteServers — real ed25519
// verification (redact per the room version, strip the out-of-band id,
// check the entry), honoring the validity floor: unknown key, expired key
// and bad signature all answer false.
export function fakeKeyResolver(...servers: RemoteServer[]): KeyResolver {
  const registry = new Map(
    servers.map((server) => [`${server.name}/${server.keyId}`, server]),
  );
  return {
    verifyEventSignature: async (args) => {
      const entry = registry.get(`${args.server}/${args.keyId}`);
      if (entry === undefined) return false;
      if (
        entry.validUntilMs !== undefined &&
        entry.validUntilMs < args.minValidUntilMs
      ) {
        return false;
      }
      let redacted: Record<string, unknown>;
      try {
        redacted = redact(
          args.pdu as unknown as Record<string, unknown>,
          args.roomVersion,
        );
      } catch {
        return false;
      }
      delete redacted.event_id;
      redacted.signatures = args.pdu.signatures as unknown as Record<
        string,
        Record<string, string>
      >;
      return await verifyJson(
        redacted,
        args.server,
        args.keyId,
        entry.kp.publicKey,
      );
    },
  };
}

// Build a remote PDU for a room, hashed, id'd and signed with the server
// key — exactly the wire shape a /send transaction, a get_missing_events
// answer or an /event answer carries.
export async function remoteEvent(
  roomId: string,
  server: RemoteServer,
  version: string,
  partial: {
    type: string;
    sender: string;
    content?: Record<string, unknown>;
    state_key?: string;
    prev_events: string[];
    auth_events?: string[];
    depth?: number;
    origin_server_ts?: number;
    // A v12 m.room.create carries no room_id (v12.md:98-101) — omit it
    // at BUILD time (it is part of the hashed event when present).
    omitRoomId?: boolean;
  },
): Promise<Pdu> {
  const pdu: Pdu = {
    type: partial.type,
    sender: partial.sender,
    room_id: roomId,
    content: (partial.content ?? {}) as Record<string, unknown>,
    prev_events: partial.prev_events,
    auth_events: partial.auth_events ?? [],
    depth: partial.depth ?? 99,
    origin_server_ts: partial.origin_server_ts ?? Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
  if (partial.omitRoomId === true) delete pdu.room_id;
  const {
    event_id: _dropId,
    signatures: _dropSig,
    hashes: _dropHash,
    ...forHash
  } = pdu as unknown as Record<string, unknown>;
  void _dropId, void _dropSig, void _dropHash;
  pdu.hashes = { sha256: await contentHashOf(forHash) };
  pdu.event_id = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    version,
  );
  // redact-then-sign (spec § hash_and_sign_event): the signature covers
  // the REDACTED form + hashes, so it verifies on redacted copies; the id
  // rides out-of-band (v3+ reference hashes) — never part of the payload
  const redacted = redact(pdu as unknown as Record<string, unknown>, version);
  delete redacted.event_id;
  delete redacted.signatures;
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    server.kp.privateKey,
    new TextEncoder().encode(canonicalJson(redacted)),
  );
  pdu.signatures = {
    [server.name]: { [server.keyId]: b64encodeStd(new Uint8Array(signature)) },
  };
  return pdu;
}

// The wire form of a PDU: no event_id (v3+ — transported out-of-band),
// no unsigned.
export function wireOf(pdu: Pdu): Pdu {
  const out = { ...(pdu as unknown as Record<string, unknown>) };
  delete out.event_id;
  delete out.unsigned;
  return out as unknown as Pdu;
}

export type FetchCalls = {
  event: string[]; // ids asked
  missingEvents: {
    roomId: string;
    earliest: string[];
    latest: string[];
    limit: number;
  }[];
  stateIds: string[]; // `at` event ids asked
  eventAuth: string[]; // event ids asked
  backfill: { from: string[]; limit: number; via: string }[];
  makeJoin: {
    roomId: string;
    userId: string;
    versions: string[];
    via: string;
  }[];
  sendJoin: { roomId: string; eventId: string | undefined; via: string }[];
};

// A Fetcher over scripted answers, recording every call. Answers go out
// in wire form (ids stripped) — the room core recomputes them (G9).
export function fakeFetcher(script: {
  missingEvents?: Pdu[];
  stateIds?: Map<string, { pduIds: string[]; authChainIds: string[] }>;
  event?: Map<string, Pdu | null>;
  eventAuth?: Map<string, Pdu[]>;
  backfill?: Pdu[] | ((from: string[], limit: number) => Pdu[]);
  makeJoin?:
    | { roomVersion: string; event: Pdu }
    | ((
      userId: string,
      via: string,
    ) =>
      | { roomVersion: string; event: Pdu }
      | Promise<{ roomVersion: string; event: Pdu }>);
  sendJoin?:
    | { state: Pdu[]; authChain: Pdu[]; event?: Pdu }
    | ((
      event: Pdu,
      via: string,
    ) =>
      | { state: Pdu[]; authChain: Pdu[]; event?: Pdu }
      | Promise<{ state: Pdu[]; authChain: Pdu[]; event?: Pdu }>);
  // Hooks for staleness tests: run while the fetch is in flight.
  onMissingEvents?: () => Promise<void>;
  onEvent?: (id: string) => Promise<void>;
  onStateIds?: (at: string) => Promise<void>;
  onEventAuth?: (id: string) => Promise<void>;
  onBackfill?: () => Promise<void>;
}): { fetcher: Fetcher; calls: FetchCalls } {
  const calls: FetchCalls = {
    event: [],
    missingEvents: [],
    stateIds: [],
    eventAuth: [],
    backfill: [],
    makeJoin: [],
    sendJoin: [],
  };
  return {
    calls,
    fetcher: {
      event: async (id) => {
        calls.event.push(id);
        if (script.onEvent !== undefined) await script.onEvent(id);
        const pdu = script.event?.get(id);
        return pdu === undefined || pdu === null ? null : wireOf(pdu);
      },
      missingEvents: async (roomId, earliest, latest, limit) => {
        calls.missingEvents.push({ roomId, earliest, latest, limit });
        if (script.onMissingEvents !== undefined) {
          await script.onMissingEvents();
        }
        return (script.missingEvents ?? []).map(wireOf);
      },
      stateIds: async (_roomId, at) => {
        calls.stateIds.push(at);
        if (script.onStateIds !== undefined) await script.onStateIds(at);
        const answer = script.stateIds?.get(at);
        return answer === undefined ? null : answer;
      },
      eventAuth: async (_roomId, id) => {
        calls.eventAuth.push(id);
        if (script.onEventAuth !== undefined) await script.onEventAuth(id);
        const answer = script.eventAuth?.get(id);
        return answer === undefined ? null : answer.map(wireOf);
      },
      backfill: async (_roomId, from, limit, via) => {
        calls.backfill.push({ from: [...from], limit, via });
        if (script.onBackfill !== undefined) await script.onBackfill();
        const answer = typeof script.backfill === 'function'
          ? script.backfill(from, limit)
          : script.backfill ?? [];
        return answer.map(wireOf);
      },
      makeJoin: async (roomId, userId, versions, via) => {
        calls.makeJoin.push({ roomId, userId, versions: [...versions], via });
        const answer = typeof script.makeJoin === 'function'
          ? await script.makeJoin(userId, via)
          : script.makeJoin;
        if (answer === undefined) {
          throw new Error('fakeFetcher: no make_join answer scripted');
        }
        return {
          roomVersion: answer.roomVersion,
          event: wireOf(answer.event),
        };
      },
      sendJoin: async (roomId, event, via) => {
        calls.sendJoin.push({ roomId, eventId: event.event_id, via });
        const answer = typeof script.sendJoin === 'function'
          ? await script.sendJoin(event, via)
          : script.sendJoin;
        if (answer === undefined) {
          throw new Error('fakeFetcher: no send_join answer scripted');
        }
        return {
          state: answer.state.map(wireOf),
          authChain: answer.authChain.map(wireOf),
          ...(answer.event === undefined
            ? {}
            : { event: wireOf(answer.event) }),
        };
      },
    },
  };
}
