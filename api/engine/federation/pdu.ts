// api/engine/federation/pdu.ts — wire form and the remote format checks.
// Served PDUs everywhere are WIRE form: the stored canonical_json minus
// our `event_id` annotation (v3+ — v3.md:66-68, the id is the derived
// reference hash, transported out-of-band) and minus `unsigned` (never
// covered by signatures — appendices.md:341-343 — nor by the content
// hash, SS:1355-1361). toWire is the ONE place that strips.
import { getRulebook } from '#engine/policy.ts';
import { checkPduFormat } from '#engine/room/verify.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { RoomVersionSpec } from '#engine/rulebook/types.ts';

export { domainOf } from '#engine/ids.ts';

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
  return { oversized: checkPduFormat(pdu, spec, opts.exemptPrevAuthLimits) };
}
