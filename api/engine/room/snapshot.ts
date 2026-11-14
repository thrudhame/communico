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
  residents: Map<string, string>;
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
  // A semantic replica retains the original resident for each evidence PDU.
  // This selects the ordinary local-sender fallback, never an auth verdict.
  residents?: ReadonlyMap<string, string>;
}): Promise<VerifiedSnapshot> {
  const rulebook = getRulebook(input.roomVersion);
  const pack = new Map<string, Pdu>();
  const residents = new Map<string, string>();
  const stateEventIds: string[] = [];
  for (
    const [events, state] of [[input.state, true], [
      input.authChain,
      false,
    ]] as const
  ) {
    for (const raw of events) {
      let admitted;
      const resident = input.residents?.get(String(raw.event_id)) ??
        input.resident;
      try {
        // The resident can vouch for our own events riding a snapshot back.
        // All other receipt checks still use the ordinary verifier.
        admitted = await verify(raw, input.roomVersion, input.keys, {
          roomId: input.roomId,
          localSnapshotFallback: { self: input.self, resident },
        });
      } catch (error) {
        if (!recoverableUpstream(error)) throw error;
        continue;
      }
      if (admitted === null) continue;
      if (!pack.has(admitted.eventId)) {
        pack.set(admitted.eventId, admitted.pdu);
        residents.set(admitted.eventId, resident);
      }
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
    residents,
    rejected,
    ordered,
    snapshot,
    createId: String(creates[0].event_id),
  };
}

/** The boundary event must be authorized against the imported before-state,
 * not just have valid bytes or an accepted declared auth chain. */
export async function authorizeSnapshotEvent(
  event: Pdu,
  roomVersion: string,
  verified: VerifiedSnapshot,
): Promise<void> {
  const rulebook = getRulebook(roomVersion);
  const id = String(event.event_id);
  if ([...verified.snapshot.values()].includes(id)) {
    badResponse('boundary event appears in its own before-state');
  }
  const store: EventStore = await withAuthProofs({
    get: (key) => key === id ? event : verified.pack.get(key),
    isRejected: (key) => verified.rejected.has(key),
  }, [...verified.pack.values(), event]);
  const chain = checkDeclaredAuth(event, rulebook, store, verified.createId);
  if (!chain.ok) {
    badResponse(
      `the join is not authorized by its auth events (${chain.rule})`,
    );
  }
  const state = rulebook.checkAuthAgainstState(event, verified.snapshot, store);
  if (!state.ok) {
    badResponse(
      `the join is not authorized against the snapshot state (${state.rule})`,
    );
  }
}
