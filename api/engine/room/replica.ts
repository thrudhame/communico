// Import existing logical-server participation, never perform a second join.
// The authenticated home manifest selects the scope; original signed PDUs and
// their complete state/auth evidence must still pass ordinary Matrix admission.
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Store } from '#engine/store/index.ts';
import { assertServerAllowed } from './acl.ts';
import { roomCreateId } from './build.ts';
import type { KeyResolver } from './deps.ts';
import { projectAfterWrite, registerCreatedRoom } from './hooks.ts';
import { initializeRoom, openRoom } from './index.ts';
import { ingestInTx } from './ingest.ts';
import { withRoomLock } from './lock.ts';
import { authorizeSnapshotEvent, verifySnapshot } from './snapshot.ts';
import { installSnapshotBoundary } from './snapshot-install.ts';
import { oversizedOf, verify } from './verify.ts';

export async function importReplicaBoundary(store: Store, input: {
  roomId: string;
  roomVersion: string;
  self: string;
  resident: string;
  keys: KeyResolver;
  join: Pdu;
  state: readonly Pdu[];
  authChain: readonly Pdu[];
}): Promise<{ roomId: string; eventId: string }> {
  const verified = await verifySnapshot(input);
  const admitted = await verify(input.join, input.roomVersion, input.keys, {
    roomId: input.roomId,
  });
  const join = admitted.pdu;
  if (
    join.type !== 'm.room.member' || join.state_key !== join.sender ||
    domainOf(join.sender) !== input.self || join.content?.membership !== 'join'
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'replica requires authentic local participation',
    );
  }
  await authorizeSnapshotEvent(join, input.roomVersion, verified);
  const aclId = verified.snapshot.get('m.room.server_acl\0');
  const acl = aclId === undefined
    ? null
    : verified.pack.get(aclId)?.content ?? {};
  assertServerAllowed(input.self, acl);
  assertServerAllowed(input.resident, acl);
  const room = await openRoom(store, input.roomId, { create: true });
  await registerCreatedRoom(store, input.roomId);
  await withRoomLock(input.roomId, () =>
    room.tx(async (tx) => {
      const existing = await tx.events.getStatus(admitted.eventId);
      const stays = (await tx.segments.list()).filter((segment) =>
        segment.kind === 'stay'
      );
      if (
        stays.some((stay) => stay.opened_by === admitted.eventId) &&
        existing?.standing === 'accepted' && existing.grounding === 'grounded'
      ) return;
      if (await tx.segments.openStay() !== null) {
        throw new MatrixError(
          400,
          'M_BAD_STATE',
          'replica already has an unrelated active boundary',
        );
      }
      const previous = stays.at(-1) ?? null;
      if (
        previous !== null &&
        await roomCreateId(tx, previous.id) !== verified.createId
      ) {
        throw new MatrixError(
          400,
          'M_BAD_JSON',
          'snapshot replaces the room create',
        );
      }
      await installSnapshotBoundary(tx, {
        roomId: input.roomId,
        roomVersion: input.roomVersion,
        event: join,
        verified,
        resident: input.resident,
        self: input.self,
        previousStay: previous?.id ?? null,
      });
    }));
  await projectAfterWrite(store, input.roomId);
  return { roomId: input.roomId, eventId: admitted.eventId };
}

/** Locally created rooms have no imported join boundary. Replaying their actual
 * genesis preserves the create event's genuine empty before-state as well as
 * the creator's existing participation, with no newly authored event. */
export async function importReplicaGenesis(store: Store, input: {
  roomId: string;
  roomVersion: string;
  self: string;
  keys: KeyResolver;
  create: Pdu;
  join: Pdu;
}): Promise<{ roomId: string; eventId: string }> {
  const verified = await verifySnapshot({
    ...input,
    resident: input.self,
    state: [input.create],
    authChain: [],
  });
  const create = verified.pack.get(verified.createId)!;
  const admitted = await verify(input.join, input.roomVersion, input.keys, {
    roomId: input.roomId,
  });
  const join = admitted.pdu;
  if (
    domainOf(create.sender) !== input.self || join.type !== 'm.room.member' ||
    join.state_key !== join.sender || domainOf(join.sender) !== input.self ||
    join.content?.membership !== 'join' || join.prev_events?.length !== 1 ||
    join.prev_events[0] !== verified.createId
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'replica requires original local genesis participation',
    );
  }
  await authorizeSnapshotEvent(join, input.roomVersion, verified);
  await withRoomLock(input.roomId, async () => {
    let existing;
    try {
      existing = await openRoom(store, input.roomId);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (existing) {
      const same = await existing.tx(async (tx) => {
        for (const eventId of [verified.createId, admitted.eventId]) {
          const status = await tx.events.getStatus(eventId);
          if (
            status?.standing !== 'accepted' || status.grounding !== 'grounded'
          ) return false;
        }
        return true;
      });
      if (!same) {
        throw new MatrixError(
          400,
          'M_BAD_STATE',
          'replica already has an unrelated genesis',
        );
      }
      return;
    }
    await initializeRoom(store, input.roomId, async (tx) => {
      const group = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: group });
      for (const pdu of [create, join]) {
        const result = await ingestInTx(tx, input.roomId, pdu, {
          remote: {
            origin: input.self,
            self: input.self,
            oversized: oversizedOf(pdu, input.roomVersion),
            ungroundedMs: 0,
          },
          initializing: true,
        });
        if (result.standing !== 'accepted' || result.grounding !== 'grounded') {
          throw new MatrixError(
            400,
            'M_BAD_JSON',
            'replica genesis failed normal ingest',
          );
        }
      }
    });
  });
  await registerCreatedRoom(store, input.roomId);
  await projectAfterWrite(store, input.roomId);
  return { roomId: input.roomId, eventId: admitted.eventId };
}
