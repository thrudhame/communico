// api/engine/room/deps.ts — the injected interfaces of the remote ingest
// (3c-1) and history/join (3c-2) paths: all network and key access
// arrives through these, so the room core never does I/O of its own.
// The real federation client and key store arrive in stage 4; tests use
// the fakes in tests/fixtures/.
import type { Pdu } from '#engine/pdu.ts';
import { MatrixError } from '#engine/matrix-error.ts';

// A Fetcher may prove that send_join was refused before membership changed.
// All other throws, including locally constructed MatrixErrors, are uncertain.
export class SendJoinRefused extends MatrixError {}

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
  // GET /_matrix/federation/v1/backfill/{roomId}?v=…&limit= — the PDUs
  // preceding the `from` ids (themselves included), up to limit
  // (backfill.yaml). The prev/auth count limits MUST NOT be validated on
  // these (backfill.yaml's note — verify.ts's exemption).
  backfill(
    roomId: string,
    from: string[],
    limit: number,
    via: string,
  ): Promise<Pdu[]>;
  // GET /_matrix/federation/v1/make_join/{roomId}/{userId}?ver=… — the
  // resident's template: the room's version and the unsigned member
  // event skeleton (joins-v1.yaml).
  makeJoin(
    roomId: string,
    userId: string,
    versions: string[],
    via: string,
  ): Promise<{ roomVersion: string; event: Pdu }>;
  // PUT /_matrix/federation/v2/send_join/{roomId}/{eventId} — the
  // resident's snapshot: the resolved state PRIOR to the join, its auth
  // chain and the resident-signed join (joins-v2.yaml; the v1 dance is
  // the client's concern — stage 4). `event` is our signed join WITH
  // its computed event_id (the transport strips it for the wire and
  // carries it on the path). Confirmed refusal throws SendJoinRefused;
  // unsuccessful transport or invalid successful answers must never do so.
  sendJoin(
    roomId: string,
    event: Pdu,
    via: string,
  ): Promise<{ state: Pdu[]; authChain: Pdu[]; event?: Pdu }>;
}

// Recovery reads use null for unreachable evidence. Normalize only the
// injected network call, never the surrounding storage/auth processing.
export async function fetchOrNull<T>(
  read: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
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
