// api/engine/room/redaction.ts — the G13 contract: accepting a redaction
// EVENT and applying its EFFECT are separate questions. The event is
// authorized by the ordinary auth rules (no redaction-target-specific
// branch); the effect (the change-log `redaction` entry — the target's
// stored PDU is never modified, R1) applies only when the redactor may
// redact the target per the room version's rules. The conditions (spec
// fragment v3-handling-redactions.md, included by v6.md:236-238,
// v10.md:278-280, v11.md:278-280 and v12.md:487-489):
//   1. the redaction sender's power level is greater than or equal to the
//      redact level — evaluated at the redaction's state before (the
//      redactor-time state, G13), or
//   2. the domain of the redaction's sender matches the domain of the
//      target's sender.
// An unknown target is not an error: the redaction is stored and a waits
// entry (R10) records the delayed effect for the 3c recheck driver.
import type { Pdu } from '#engine/pdu.ts';
import { domainOf } from '#engine/ids.ts';
import {
  namedLevel,
  parsePowerLevels,
  userPowerLevel,
} from '#engine/rulebook/power-levels.ts';
import type { RoomVersionSpec } from '#engine/rulebook/index.ts';
import type { EventRow, RoomTx } from '#engine/room/index.ts';

// The target id of a redaction event: under content in v11+
// (v11.md:70-81), top-level for ≤10 (pdu_v6.yaml:27-30).
export function redactionTarget(pdu: Pdu): string | null {
  const inContent = pdu.content?.redacts;
  if (typeof inContent === 'string') return inContent;
  return typeof pdu.redacts === 'string' ? pdu.redacts : null;
}

async function statePdu(
  tx: RoomTx,
  group: number,
  type: string,
  stateKey: string,
): Promise<Pdu | null> {
  const id = await tx.state.groupKey(group, type, stateKey);
  if (id === null) return null;
  const row = await tx.events.get(id);
  return row === null ? null : (JSON.parse(row.pdu) as Pdu);
}

// The effect permission, evaluated at the redaction's own before-group
// (redactor-time state — never the current state, never the target's).
export async function redactionEffectAllowed(
  tx: RoomTx,
  spec: RoomVersionSpec,
  redaction: Pdu,
  target: EventRow,
  beforeGroup: number,
): Promise<boolean> {
  // Condition 2: matching sender domains.
  if (domainOf(String(redaction.sender)) === domainOf(target.sender)) {
    return true;
  }
  // Condition 1: the redactor's power level ≥ the redact level.
  const plPdu = await statePdu(tx, beforeGroup, 'm.room.power_levels', '');
  const createPdu = await statePdu(tx, beforeGroup, 'm.room.create', '');
  const parsed = plPdu === null ? null : parsePowerLevels(plPdu.content, spec);
  const pl = parsed !== null && parsed.ok ? parsed.pl : null;
  return userPowerLevel(String(redaction.sender), plPdu, createPdu, spec) >=
    namedLevel('redact', pl);
}
