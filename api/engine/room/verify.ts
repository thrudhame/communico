// api/engine/room/verify.ts — the ONE verification path for every PDU
// received from another server (G9/G10): by any arrival route (/send, a
// fetched missing event, a fetched auth-chain event), the PDU passes the
// same checks, and what is stored is the verified PDU without `unsigned`
// (G10: never the raw ingress bytes; client redaction stays a read-time
// projection). The receipt ladder (server-server-api.md:456-477):
//   1. per-version format checks — a failure drops the event (thrown).
//      The one lenient case, a codepoint-measured per-key size failure
//      in a ≤ v10 room, comes back as `oversized` (stored rejected —
//      never a drop);
//   —  `unsigned` is stripped on receipt (covered by neither the
//      signatures nor the content hash);
//   —  the event id is RECOMPUTED, never trusted: a mismatch, an
//      uncanonicalizable body, or a v12 room-id mismatch drops the event;
//   3. the content hash — a mismatch means we were given a redacted
//      version: the redacted copy WE calculated replaces the event for
//      further processing (server-server-api.md:1525-1530);
//   2. the signature from the originating server — the server the
//      `sender` belongs to (server-server-api.md:1500-1504; forwarding
//      by any transport origin is allowed, so the delivering server is
//      irrelevant here) — verified through the injected KeyResolver,
//      honoring the room version's key-validity rule at the event's
//      origin_server_ts (v5-signing-requirements.md:2-16). A failure or
//      an unobtainable key drops the event.
// The idempotency check (same-id redelivery returns the original receipt
// WITHOUT re-verification; a pending redelivery falls through) is the
// caller's composition: identify() supplies the recomputed id for it.
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import { getRulebook, type RoomVersionSpec } from '#engine/rulebook/index.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import { contentHashOf } from '#engine/signing-primitives.js';

export type Identified = {
  eventId: string;
  // A lenient-version per-key size failure — the caller stores the event
  // rejected (old 'oversized' reason), never drops it.
  oversized: boolean;
};

export type Verified = Identified & {
  // The verified PDU: the same object, with `unsigned` removed and — on
  // a content-hash mismatch — replaced by its redacted form.
  pdu: Pdu;
};

type VerifyOptions = {
  roomId?: string;
  exemptPrevAuthLimits?: boolean;
  // Re-join snapshots may carry our own historical events with a resident
  // signature. Only our sender domain is eligible, after all normal checks.
  localSnapshotFallback?: { self: string; resident: string };
};

function domainOf(userId: string): string {
  const at = userId.indexOf(':');
  return at === -1 ? userId : userId.slice(at + 1);
}

// Check 1: the wire bounds and the per-version format checks (old
// federation/pdu.ts checkRemoteFormat). A hard failure throws; the
// lenient size case is returned. The backfill count exemption
// (backfill.yaml's note: prev/auth counts MUST NOT be validated on a
// backfill response) is the caller's option — /backfill answers only.
function checkFormat(
  pdu: Pdu,
  spec: RoomVersionSpec,
  exemptPrevAuthLimits: boolean,
): boolean {
  for (const list of [pdu.prev_events, pdu.auth_events]) {
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.some((id) => typeof id !== 'string'))
    ) {
      throw new Error(
        'M_BAD_EVENT: prev_events/auth_events must be string arrays',
      );
    }
  }
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];
  if (!exemptPrevAuthLimits) {
    if (prevIds.length > 20) {
      throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
    }
    if (declaredAuth.length > 10) {
      throw new Error('M_TOO_MANY_AUTH_EVENTS: v11 allows at most 10');
    }
  }
  if (
    typeof pdu.type !== 'string' || typeof pdu.sender !== 'string' ||
    typeof pdu.depth !== 'number' || !Number.isInteger(pdu.depth) ||
    pdu.depth < 0 ||
    typeof pdu.origin_server_ts !== 'number' ||
    pdu.content === null || typeof pdu.content !== 'object'
  ) {
    throw new Error('M_BAD_EVENT: missing or malformed required fields');
  }
  if (pdu.state_key !== undefined && typeof pdu.state_key !== 'string') {
    throw new Error('M_BAD_EVENT: state_key must be a string when present');
  }
  if (!spec.roomIdFromCreateEvent && typeof pdu.room_id !== 'string') {
    throw new Error('M_BAD_EVENT: room_id required before v12');
  }
  // depth bounded only (components/depth_v6.yaml:19-25 — the only MUST)
  const depthBound = spec.depthLimit === 'int53' ? 2 ** 53 - 1 : 2 ** 63 - 1;
  if (pdu.depth > depthBound) {
    throw new Error('M_BAD_EVENT: depth exceeds the room version limit');
  }
  let canonical: string;
  try {
    canonical = canonicalJson(pdu as unknown as Record<string, unknown>);
  } catch (e) {
    throw new Error('M_BAD_EVENT: ' + String(e));
  }
  // whole canonical event ≤ 65536 bytes (CS:2869-2871)
  if (new TextEncoder().encode(canonical).length > 65536) {
    throw new Error('M_TOO_LARGE: event exceeds the 65536-byte limit');
  }
  // per-key limits: type/state_key ≤ 255 — BYTES for strictByteLimits
  // versions (v11+), codepoints for ≤ v10 (CS:2874-2877)
  const measure = (s: string): number =>
    spec.strictByteLimits ? new TextEncoder().encode(s).length : [...s].length;
  const keyFail = measure(pdu.type) > 255 ||
    (pdu.state_key !== undefined && measure(String(pdu.state_key)) > 255);
  let oversized = false;
  if (keyFail) {
    if (spec.strictByteLimits) {
      throw new Error('M_BAD_EVENT: type/state_key exceed 255 bytes');
    }
    oversized = true;
  }
  // sender/room_id/event_id bounded by their identifier grammars
  for (const id of [pdu.sender, pdu.room_id, pdu.event_id]) {
    if (typeof id === 'string' && new TextEncoder().encode(id).length > 255) {
      throw new Error('M_BAD_EVENT: identifier exceeds its grammar limit');
    }
  }
  return oversized;
}

// The lenient-version size verdict over a stored (verified) PDU —
// deterministic, no verification needed (the resume driver recomputes
// it; the flag is never persisted). Strict versions always answer false:
// such an event would have been dropped at receipt, never stored.
export function oversizedOf(pdu: Pdu, roomVersion: string): boolean {
  const spec = getRulebook(roomVersion).spec;
  if (spec.strictByteLimits) return false;
  const measure = (s: string): number => [...s].length;
  return measure(String(pdu.type)) > 255 ||
    (pdu.state_key !== undefined && measure(String(pdu.state_key)) > 255);
}

// Checks 1 + id: format guards, unsigned strip, the recomputed event id
// and the v12 room-id defence. `roomId` is the room context for the v12
// create check (a v12 room id IS the create's event id — v12.md:98-101);
// `exemptPrevAuthLimits` is the /backfill answer exemption.
export async function identify(
  pdu: Pdu,
  roomVersion: string,
  opts: { roomId?: string; exemptPrevAuthLimits?: boolean } = {},
): Promise<Identified> {
  const spec = getRulebook(roomVersion).spec; // unknown: never a default
  const oversized = checkFormat(pdu, spec, opts.exemptPrevAuthLimits === true);
  // `unsigned` stripped on receipt — never stored (appendices.md:341-343)
  delete pdu.unsigned;
  let eventId: string;
  try {
    eventId = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      roomVersion,
    );
  } catch (e) {
    throw new Error('M_BAD_EVENT: ' + String(e));
  }
  if (pdu.event_id !== undefined && pdu.event_id !== eventId) {
    throw new Error('M_BAD_EVENT: event_id does not recompute');
  }
  // the wire form has no event_id (v3+, transported out-of-band) —
  // restore the computed one: the stored PDU carries its derived id
  pdu.event_id = eventId;
  if (
    spec.roomIdFromCreateEvent && pdu.type === 'm.room.create' &&
    opts.roomId !== undefined && opts.roomId !== '!' + eventId.slice(1)
  ) {
    throw new Error(
      'E_ROOM_ID_MISMATCH: v12 room id is not the create event id',
    );
  }
  return { eventId, oversized };
}

// The full path: identify + the content hash (check 3, redacting on
// mismatch) + the originating-server signature (check 2). The
// `exemptPrevAuthLimits` option is the /backfill answer exemption
// (backfill.yaml's note).
export async function verify(
  pdu: Pdu,
  roomVersion: string,
  keys: KeyResolver,
  opts: VerifyOptions = {},
): Promise<Verified> {
  const spec = getRulebook(roomVersion).spec;
  const { eventId, oversized } = await identify(pdu, roomVersion, opts);

  // Check 3: the content hash covers the complete event minus unsigned,
  // signatures and hashes (the v11+ wire form has no event_id — strip
  // our annotation as at signing time). A body that does not
  // canonicalize is malformed (dropped), never redact-accepted.
  let hashOk = false;
  try {
    const { event_id: _drop, ...noId } = pdu as unknown as Record<
      string,
      unknown
    >;
    void _drop;
    hashOk = (await contentHashOf(noId)) === pdu.hashes?.sha256;
  } catch (e) {
    throw new Error(
      'M_BAD_EVENT: content cannot be canonicalized — ' + String(e),
    );
  }
  if (!hashOk) {
    // We were given a redacted version of the event: use the redacted
    // copy we calculated (server-server-api.md:1525-1530).
    const redacted = redact(
      pdu as unknown as Record<string, unknown>,
      roomVersion,
    );
    for (const key of Object.keys(pdu)) {
      delete (pdu as unknown as Record<string, unknown>)[key];
    }
    Object.assign(pdu, redacted);
  }

  // Check 2: a verifying signature from the sender's server, through the
  // injected resolver. An unobtainable key under one id tries the next;
  // a failure or no key drops the event, never a deferral.
  const senderDomain = domainOf(String(pdu.sender));
  const minValidUntilMs = spec.enforceKeyValidity
    ? Number(pdu.origin_server_ts)
    : 0;
  const verifiedBy = async (server: string): Promise<boolean> => {
    for (
      const keyId of Object.keys(
        (pdu.signatures as Record<string, Record<string, string>> | undefined)
          ?.[
            server
          ] ?? {},
      )
    ) {
      try {
        if (
          await keys.verifyEventSignature({
            server,
            keyId,
            pdu,
            roomVersion,
            minValidUntilMs,
          })
        ) {
          return true;
        }
      } catch {
        // key unobtainable under this id - try the next
      }
    }
    return false;
  };
  let sigOk = await verifiedBy(senderDomain);
  const fallback = opts.localSnapshotFallback;
  if (!sigOk && fallback !== undefined && senderDomain === fallback.self) {
    sigOk = await verifiedBy(fallback.resident);
  }
  if (!sigOk) {
    throw new Error('M_UNAUTHORIZED: PDU signature missing or invalid');
  }
  return { eventId, oversized, pdu };
}
