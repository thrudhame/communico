// Shared admission of an imported state/auth pack. This does not create a join,
// a room, a state group or a publication position. Each consumer must prove its
// own boundary/participation contract before materializing the admitted state.
import { withAuthProofs } from '#engine/auth-proofs.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  type EventStore,
  getRulebook,
  type StateMap,
} from '#engine/rulebook/index.ts';
import { checkDeclaredAuth } from './build.ts';
import type { KeyResolver } from './deps.ts';
import { orderEvents } from './order.ts';
import { verify } from './verify.ts';

export type VerifiedSnapshot = {
  pack: Map<string, Pdu>;
  rejected: Map<string, string>;
  ordered: (readonly [string, Pdu])[];
  snapshot: StateMap;
  createId: string;
};

function badResponse(message: string): never {
  throw new MatrixError(502, 'M_UNKNOWN', message);
}

export async function verifySnapshot(input: {
  roomId: string;
  roomVersion: string;
  resident: string;
  self: string;
  keys: KeyResolver;
  state: readonly Pdu[];
  authChain: readonly Pdu[];
}): Promise<VerifiedSnapshot> {
  const rulebook = getRulebook(input.roomVersion);
  const pack = new Map<string, Pdu>();
  const stateEventIds: string[] = [];
  for (
    const [events, state] of [[input.state, true], [
      input.authChain,
      false,
    ]] as const
  ) {
    for (const raw of events) {
      let admitted;
      try {
        // The resident can vouch for our own events riding a snapshot back.
        // All other receipt checks still use the ordinary verifier.
        admitted = await verify(raw, input.roomVersion, input.keys, {
          roomId: input.roomId,
          localSnapshotFallback: { self: input.self, resident: input.resident },
        });
      } catch (error) {
        if (!recoverableUpstream(error)) throw error;
        continue;
      }
      if (admitted === null) continue;
      if (!pack.has(admitted.eventId)) pack.set(admitted.eventId, admitted.pdu);
      if (state) stateEventIds.push(admitted.eventId);
    }
  }
  const rejected = new Map([...pack.keys()].map((id) => [id, 'unchecked']));
  const packStore: EventStore = await withAuthProofs({
    get: (id) => pack.get(id),
    isRejected: (id) => rejected.has(id),
  }, pack.values());
  const stateIdSet = new Set(stateEventIds);
  const snapshotCreates = [...stateIdSet].filter((id) =>
    pack.get(id)?.type === 'm.room.create' &&
    checkDeclaredAuth(pack.get(id)!, rulebook, packStore, null).ok
  );
  if (snapshotCreates.length !== 1) {
    badResponse('snapshot has no single create');
  }
  const ordered = orderEvents(
    [...pack].map(([eventId, pdu]) => ({ eventId, pdu })),
    ['auth_events'],
  ).map(({ eventId, pdu }) => [eventId, pdu] as const);
  for (const [id, pdu] of ordered) {
    rejected.delete(id);
    const chain = checkDeclaredAuth(
      pdu,
      rulebook,
      packStore,
      snapshotCreates[0],
    );
    if (!chain.ok) rejected.set(id, chain.rule);
  }
  const creates = stateEventIds
    .filter((id) => !rejected.has(id))
    .map((id) => pack.get(id)!)
    .filter((pdu) => pdu.type === 'm.room.create');
  if (creates.length !== 1) badResponse('snapshot has no single create');
  if (String(creates[0].content?.room_version ?? '') !== input.roomVersion) {
    badResponse(
      `snapshot create says room_version ${
        String(creates[0].content?.room_version)
      }, expected ${input.roomVersion}`,
    );
  }
  const snapshot: StateMap = new Map();
  for (const id of stateEventIds) {
    if (rejected.has(id)) continue;
    const pdu = pack.get(id)!;
    if (pdu.state_key !== undefined) {
      snapshot.set(String(pdu.type) + '\0' + String(pdu.state_key), id);
    }
  }
  return {
    pack,
    rejected,
    ordered,
    snapshot,
    createId: String(creates[0].event_id),
  };
}
