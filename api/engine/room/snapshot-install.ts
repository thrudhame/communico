// Join and replica bootstrap share the same evidence and state materialization
// boundary. Call with a verified, authorized original event and the room lock.
import { canonicalJson } from '#engine/canonical.ts';
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
  },
): Promise<void> {
  const eventId = String(input.event.event_id);
  for (const [id, pdu] of input.verified.ordered) {
    if (id === eventId || await tx.events.get(id) !== null) continue;
    const rule = input.verified.rejected.get(id) ?? null;
    await tx.events.insert(
      id,
      canonicalJson(pdu as unknown as Record<string, unknown>),
    );
    await tx.events.setStatus(id, {
      standing: rule === null ? 'accepted' : 'rejected',
      grounding: 'evidence',
      origin: input.resident,
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
      origin: input.resident,
    });
  }
  const group = await tx.materialize.newGroup(
    null,
    mapEntries(input.verified.snapshot),
  );
  const stay = await tx.segments.create({
    kind: 'stay',
    prev: input.previousStay,
    opening_group: group,
  });
  const result = await ingestInTx(tx, input.roomId, input.event, {
    remote: {
      origin: input.resident,
      self: input.self,
      oversized: oversizedOf(input.event, input.roomVersion),
      ungroundedMs: 0,
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
