// api/engine/federation/pdu.ts — wire form and the remote format checks.
// Served PDUs everywhere are WIRE form: the stored canonical_json minus
// our `event_id` annotation (v3+ — v3.md:66-68, the id is the derived
// reference hash, transported out-of-band) and minus `unsigned` (never
// covered by signatures — appendices.md:341-343 — nor by the content
// hash, SS:1355-1361). toWire is the ONE place that strips.
import { getRulebook } from '../policy.ts';
import { canonicalJson } from '../canonical.ts';
import type { Pdu } from '../pdu.ts';
import type { RoomVersionSpec } from '../rulebook/types.ts';

// The server-name part of an identifier (user/room/event id): everything
// after the FIRST ':' (server names may themselves carry :port).
export function domainOf(id: string): string {
  const at = id.indexOf(':');
  return at < 0 ? id : id.slice(at + 1);
}

// The wire form of a stored PDU for the given room version.
export function toWire(
  pdu: Pdu,
  roomVersion: string,
): Record<string, unknown> {
  void getRulebook(roomVersion); // unknown version is a bug, not a wire case
  const out = { ...(pdu as unknown as Record<string, unknown>) };
  delete out.event_id;
  delete out.unsigned;
  return out;
}

// The PDU base required fields (pdu_base.yaml:67-74; + room_id for
// ≤ v11 — components/room_id_before_v12.yaml:22-23) and the size limits
// (CS:2867-2883; identifier grammars in appendices.md). A format failure
// means the PDU is INVALID, dropped (spec: "otherwise it is dropped") —
// thrown here. The ONE lenient case: a per-key limit measured in
// codepoints (≤ v10) fails — that is stored rejected 'oversized'
// (Synapse federation_event.py:1852-1868), returned not thrown.
// `exemptPrevAuthLimits`: backfill answers forbid validating prev/auth
// counts (backfill.yaml:60-66).
export function checkRemoteFormat(
  pdu: Pdu,
  spec: RoomVersionSpec,
  opts: { exemptPrevAuthLimits: boolean },
): { oversized: boolean } {
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];
  if (!opts.exemptPrevAuthLimits) {
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
  if (!spec.roomIdFromCreateEvent && typeof pdu.room_id !== 'string') {
    throw new Error('M_BAD_EVENT: room_id required before v12');
  }
  // depth bounded only (components/depth_v6.yaml:19-25 — the only MUST)
  const depthBound = spec.depthLimit === 'int53' ? 2 ** 53 - 1 : 2 ** 63 - 1;
  if (pdu.depth > depthBound) {
    throw new Error('M_BAD_EVENT: depth exceeds the room version limit');
  }
  // whole canonical event ≤ 65536 bytes (CS:2869-2871)
  if (
    new TextEncoder().encode(
      canonicalJson(pdu as unknown as Record<string, unknown>),
    ).length > 65536
  ) {
    throw new Error('M_TOO_LARGE: event exceeds the 65536-byte limit');
  }
  // per-key limits: type/state_key ≤ 255 — BYTES for strictByteLimits
  // versions (v11+), codepoints for ≤ v10 (CS:2874-2877;
  // TestOutboundFederationEventSizeGetMissingEvents sends a 70-codepoint /
  // 280-byte state_key at a v10 room, which must pass)
  const measure = (s: string): number =>
    spec.strictByteLimits ? new TextEncoder().encode(s).length : [...s].length;
  let oversized = false;
  const keyFail = measure(pdu.type) > 255 ||
    (pdu.state_key !== undefined && measure(String(pdu.state_key)) > 255);
  if (keyFail) {
    if (spec.strictByteLimits) {
      throw new Error('M_BAD_EVENT: type/state_key exceed 255 bytes');
    }
    oversized = true;
  }
  // sender/room_id/event_id bounded by their identifier grammars
  // (CS:2873,2878; appendices user/room/event-id sections — 255 bytes)
  for (const id of [pdu.sender, pdu.room_id, pdu.event_id]) {
    if (typeof id === 'string' && new TextEncoder().encode(id).length > 255) {
      throw new Error('M_BAD_EVENT: identifier exceeds its grammar limit');
    }
  }
  return { oversized };
}
