// api/engine/room/deps.ts — the injected interfaces of the remote ingest
// path (3c-1): all network and key access arrives through these, so the
// room core never does I/O of its own. The real federation client and key
// store arrive in stage 4; tests use the fakes in tests/fixtures/.
import type { Pdu } from '#engine/pdu.ts';

// KeyResolver: verify one signature entry of an event at a time. The
// resolver owns key discovery (direct fetch, witnesses, caching — stage
// 4) and answers whether `signatures[server][keyId]` of `pdu` verifies
// against the resolved key. `minValidUntilMs` is the key-validity floor:
// the event's origin_server_ts when the room version enforces key
// validity (v5+, v5-signing-requirements.md:2-16), else 0. Returns false
// when the key is unknown, expired before the floor, or the signature
// does not verify.
export interface KeyResolver {
  verifyEventSignature(args: {
    server: string;
    keyId: string;
    pdu: Pdu;
    roomVersion: string;
    minValidUntilMs: number;
  }): Promise<boolean>;
}

// Fetcher: the federation reads the missing-event recovery needs (plan
// §2 row 1). `via` is the server to ask. Every answer is untrusted input:
// the room core passes everything a Fetcher returns through the one
// verification path (verify.ts, G9) before any of it is stored.
export interface Fetcher {
  // GET /_matrix/federation/v1/event/{eventId} — the PDU, or null on
  // 404/unreachable.
  event(id: string, via: string): Promise<Pdu | null>;
  // POST /_matrix/federation/v1/get_missing_events/{roomId}: the events
  // between earliest (our extremities) and latest (the pushed event),
  // forward-topological, up to limit (backfill.yaml:71-141).
  missingEvents(
    roomId: string,
    earliest: string[],
    latest: string[],
    limit: number,
    via: string,
  ): Promise<Pdu[]>;
  // GET /_matrix/federation/v1/state_ids/{roomId}?event_id=at — the full
  // state at the event plus its auth chain (events.yaml:124-142).
  stateIds(
    roomId: string,
    at: string,
    via: string,
  ): Promise<{ pduIds: string[]; authChainIds: string[] } | null>;
  // GET /_matrix/federation/v1/event_auth/{roomId}/{eventId} — the
  // complete auth chain of the event (event_auth.yaml).
  eventAuth(roomId: string, id: string, via: string): Promise<Pdu[] | null>;
}

// The bounds and identity the remote ingest needs (plan §2 row 3): the
// [federation] missing-event leaves (existing config), the terminal rule
// for events whose prevs stay missing (ungroundedmillihours, in ms; 0
// drops instead of storing — old ruling B), and our own server name.
// missingmax is the SERVING-side cap of get_missing_events and has no
// consumer in this inbound path (3c-2/stage 4).
export type RemoteDeps = {
  keys: KeyResolver;
  fetcher: Fetcher;
  self: string;
  limits: {
    waitMs: number; // [federation] missingwaitms
    limit: number; // [federation] missinglimit
    budgetMs: number; // [federation] missingbudgetms
  };
  ungroundedMs: number;
};
