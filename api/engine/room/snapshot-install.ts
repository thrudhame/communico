// Join and replica bootstrap share the same evidence and state materialization
// boundary. Call with a verified, authorized original event and the room lock.
import type { Pdu } from '#engine/pdu.ts';
import { ingestInTx } from './ingest.ts';
import type { RoomTx } from './index.ts';
import type { VerifiedSnapshot } from './snapshot.ts';
import { mapEntries } from './state.ts';
import { oversizedOf } from './verify.ts';

export async function installSnapshotBoundary(
  tx: RoomTx,
  input: {
    roomId: string;
    roomVersion: string;
    event: Pdu;
    verified: VerifiedSnapshot;
    resident: string;
    self: string;
    previousStay: number | null;
    preserveFrontier?: boolean;
  },
): Promise<void> {
  const eventId = String(input.event.event_id);
  await stageSnapshotEvidence(tx, input.verified, eventId);
  const group = input.preserveFrontier && input.previousStay !== null
    ? await tx.state.current(input.previousStay)
    : await tx.materialize.newGroup(null, mapEntries(input.verified.snapshot));
  if (group === null) {
    throw new Error('E_STATE_MISSING: archived replica state');
  }
  const stay = await tx.segments.create({
    kind: 'stay',
    prev: input.previousStay,
    opening_group: group,
  });
  if (input.preserveFrontier && input.previousStay !== null) {
    // Keep the receiver's concurrent branch. Incoming before-state is evidence
    // for the join, never a replacement for already published local history.
    await tx.extremities.inherit(input.previousStay, stay);
  }
  const result = await ingestInTx(tx, input.roomId, input.event, {
    remote: {
      origin: input.resident,
      self: input.self,
      oversized: oversizedOf(input.event, input.roomVersion),
      ungroundedMs: 0,
      promoteEvidence: input.preserveFrontier,
      boundary: input.verified.snapshot,
    },
  });
  if (result.standing !== 'accepted' || result.grounding !== 'grounded') {
    throw new Error(
      `E_JOIN_NOT_ACCEPTED: ${result.standing} (${result.reason ?? ''}${
        result.rule === null ? '' : ', rule ' + result.rule
      })`,
    );
  }
  await tx.segments.setOpenedBy(stay, eventId);
}

/** Join and in-stay replica recovery use one verified outlier staging owner. */
export async function stageSnapshotEvidence(
  tx: RoomTx,
  verified: VerifiedSnapshot,
  eventId: string,
): Promise<void> {
  for (const [id, pdu] of verified.ordered) {
    if (id === eventId || await tx.events.get(id) !== null) continue;
    const resident = verified.residents.get(id)!;
    const rule = verified.rejected.get(id) ?? null;
    await tx.events.insert(
      id,
      pdu,
    );
    await tx.events.setStatus(id, {
      standing: rule === null ? 'accepted' : 'rejected',
      grounding: 'evidence',
      origin: resident,
      received_ts: Date.now(),
    });
    await tx.changes.append('event', id, {
      standing: rule === null ? 'accepted' : 'rejected',
      reason: rule === null ? null : 'auth',
      rule,
      type: String(pdu.type),
      state_key: pdu.state_key ?? null,
      sender: String(pdu.sender),
      depth: pdu.depth,
      origin_server_ts: pdu.origin_server_ts,
      stay: null,
      offset: null,
      grounding: 'evidence',
      origin: resident,
    });
  }
}
