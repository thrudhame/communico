// Rebuild a semantic room manifest with the existing admission, ingest and
// history owners. Source row IDs and source verdicts never become local truth.
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Store } from '#engine/store/index.ts';
import { assertAcl } from './acl.ts';
import { roomCreateId, roomVersionOf } from './build.ts';
import type { Fetcher, KeyResolver } from './deps.ts';
import { backfill } from './history.ts';
import { projectAfterWrite } from './hooks.ts';
import { openRoom } from './index.ts';
import { ingestInTx } from './ingest.ts';
import { withRoomLock } from './lock.ts';
import { importReplicaBoundary, importReplicaGenesis } from './replica.ts';
import type { ReplicaRoom } from './replica-export.ts';
import { stageSnapshotEvidence } from './snapshot-install.ts';
import { verifySnapshot } from './snapshot.ts';
import { verify } from './verify.ts';

function unavailable(message: string): never {
  throw new MatrixError(503, 'M_UNAVAILABLE', message);
}

export async function importReplicaRoom(
  store: Store,
  manifest: ReplicaRoom,
  input: { self: string; keys: KeyResolver; signal?: AbortSignal },
): Promise<void> {
  if (manifest.version !== 1) {
    throw new MatrixError(400, 'M_BAD_JSON', 'replica manifest version');
  }
  if (manifest.after > 0) await openRoom(store, manifest.roomId);
  const pack = new Map<string, Pdu>();
  for (const raw of manifest.events) {
    input.signal?.throwIfAborted();
    const verified = await verify(raw, manifest.roomVersion, input.keys, {
      roomId: manifest.roomId,
      exemptPrevAuthLimits: true,
    });
    if (raw.event_id !== verified.eventId || pack.has(verified.eventId)) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'replica event identity collision',
      );
    }
    pack.set(verified.eventId, verified.pdu);
  }
  const event = (id: string): Pdu =>
    pack.get(id) ?? unavailable('replica event is unavailable');
  const boundaries = new Map(
    manifest.boundaries.map((boundary) => [boundary.eventId, boundary]),
  );
  const snapshot = (id: string) => {
    const boundary = boundaries.get(id);
    if (!boundary) unavailable('replica before-state is unavailable');
    return {
      state: boundary.state.map(event),
      authChain: boundary.authChain.map(event),
    };
  };
  const unsupported = () =>
    Promise.reject(new Error('replica is not a network fetcher'));
  let page: Pdu[] = [];
  const fetcher: Fetcher = {
    event: (id) => Promise.resolve(pack.get(id) ?? null),
    timestampToEvent: () => Promise.resolve(null),
    missingEvents: () => Promise.resolve([]),
    stateIds: (_room, id) => {
      const boundary = boundaries.get(id);
      return Promise.resolve(
        boundary
          ? { pduIds: boundary.state, authChainIds: boundary.authChain }
          : null,
      );
    },
    state: (_room, id) =>
      Promise.resolve(boundaries.has(id) ? snapshot(id) : null),
    eventAuth: (_room, id) => {
      const ids = [...(event(id).auth_events ?? [])];
      const closure = new Set<string>();
      for (let i = 0; i < ids.length; i++) {
        if (closure.has(ids[i])) continue;
        closure.add(ids[i]);
        ids.push(...(event(ids[i]).auth_events ?? []));
      }
      return Promise.resolve([...closure].map(event));
    },
    backfill: () => Promise.resolve(page),
    makeJoin: unsupported,
    sendJoin: unsupported,
  };
  const stays = new Map(
    manifest.stays.map((stay) => [stay.opening.eventId, stay]),
  );
  const initialized = new Set<string>();
  const ensure = async (id: string, origin: string) => {
    if (initialized.has(id)) return;
    const stay = stays.get(id);
    if (!stay) unavailable('replica stay is unavailable');
    const opening = stay.opening;
    if (opening.kind === 'genesis') {
      await importReplicaGenesis(store, {
        ...input,
        roomId: manifest.roomId,
        roomVersion: manifest.roomVersion,
        create: event(opening.createId),
        join: event(id),
      });
    } else {
      await importReplicaBoundary(store, {
        ...input,
        roomId: manifest.roomId,
        roomVersion: manifest.roomVersion,
        resident: origin,
        join: event(id),
        ...snapshot(id),
      });
    }
    initialized.add(id);
  };
  for (let i = 0; i < manifest.steps.length;) {
    input.signal?.throwIfAborted();
    const step = manifest.steps[i];
    await ensure(step.stay, step.origin);
    const room = await openRoom(store, manifest.roomId);
    if (step.kind === 'history') {
      const chunk = [];
      do {
        chunk.push(manifest.steps[i++]);
      } while (
        i < manifest.steps.length && manifest.steps[i].kind === 'history' &&
        manifest.steps[i].stay === step.stay &&
        manifest.steps[i].anchor === step.anchor &&
        manifest.steps[i].origin === step.origin
      );
      page = chunk.map((entry) => event(entry.eventId));
      const stay = await room.tx(async (tx) => {
        const opening = stays.get(step.stay)!.opening;
        return (await tx.segments.list()).find((held) =>
          held.kind === 'stay' &&
          (opening.kind === 'genesis'
            ? held.opened_by === null
            : held.opened_by === step.stay)
        );
      });
      if (!stay) unavailable('replica history has no participation');
      // Closed local bytes need no network request/work/time quota. Cancellation
      // belongs to the caller; normal history verification and auth still run.
      const signal = input.signal ?? new AbortController().signal;
      await backfill(room, {
        from: chunk.map((entry) => entry.eventId),
        limit: page.length,
        via: step.origin,
        stay: stay.id,
        isolated: step.anchor !== null,
      }, {
        keys: input.keys,
        fetcher,
        signal,
        budget: {
          signal,
          requests: Infinity,
          work: Infinity,
          exhausted: false,
        },
      });
      for (const entry of chunk) {
        if (!(await room.tx((tx) => tx.state.eventStateAfter(entry.eventId)))) {
          unavailable('replica history did not ground');
        }
      }
      continue;
    }
    i++;
    const pdu = event(step.eventId);
    const verified = await verify(pdu, manifest.roomVersion, input.keys, {
      roomId: manifest.roomId,
    });
    const boundary = boundaries.has(step.eventId)
      ? await verifySnapshot({
        ...input,
        roomId: manifest.roomId,
        roomVersion: manifest.roomVersion,
        resident: step.origin,
        ...snapshot(step.eventId),
      })
      : undefined;
    await withRoomLock(room.id, () =>
      room.tx(async (tx) => {
        const existing = await tx.events.get(step.eventId);
        if (existing) {
          const held = JSON.parse(existing.pdu) as Pdu;
          if (canonicalJson(held) !== canonicalJson(verified.pdu)) {
            throw new MatrixError(
              400,
              'M_BAD_JSON',
              'replica changes a retained event',
            );
          }
        }
        if (
          (await tx.events.getStatus(step.eventId))?.grounding === 'grounded'
        ) return;
        const stay = await tx.segments.openStay();
        if (
          !stay || await roomVersionOf(tx, stay.id) !== manifest.roomVersion
        ) unavailable('replica live stay is unavailable');
        await assertAcl(tx, step.origin);
        if (boundary) {
          if (await roomCreateId(tx, stay.id) !== boundary.createId) {
            throw new MatrixError(
              400,
              'M_BAD_JSON',
              'replica replaces room create',
            );
          }
          await stageSnapshotEvidence(tx, boundary, step.eventId, step.origin);
        }
        const result = await ingestInTx(tx, room.id, verified.pdu, {
          remote: {
            origin: step.origin,
            self: input.self,
            oversized: verified.oversized,
            ungroundedMs: 0,
            boundary: boundary?.snapshot,
          },
        });
        if (result.grounding !== 'grounded') {
          unavailable('replica live event did not ground');
        }
      }));
    await projectAfterWrite(store, room.id);
  }
  for (const [id, expected] of stays) {
    if (!initialized.has(id)) {
      await ensure(id, input.self);
    }
    const room = await openRoom(store, manifest.roomId);
    const closed = await room.tx(async (tx) => {
      const stay = (await tx.segments.list()).find((held) =>
        held.kind === 'stay' &&
        (expected.opening.kind === 'genesis'
          ? held.opened_by === null
          : held.opened_by === id)
      );
      return stay?.status === 'closed';
    });
    if (closed !== expected.closed) {
      unavailable('replica participation cut is incomplete');
    }
  }
  // Retain outlier/pending bytes as independently auth-checked evidence, not
  // copied source status or live publication. Later source transitions can
  // ground them normally. This also works after the final stay has closed.
  const first = manifest.stays[0];
  if (!first) unavailable('replica has no participation');
  const evidence = await verifySnapshot({
    ...input,
    roomId: manifest.roomId,
    roomVersion: manifest.roomVersion,
    resident: input.self,
    state: [event(first.opening.createId)],
    authChain: [...pack.values()],
  });
  const room = await openRoom(store, manifest.roomId);
  await withRoomLock(room.id, () =>
    room.tx(async (tx) => {
      const stay = await tx.segments.latestStay();
      if (!stay || await roomCreateId(tx, stay.id) !== evidence.createId) {
        throw new MatrixError(
          400,
          'M_BAD_JSON',
          'replica replaces retained room create',
        );
      }
      await stageSnapshotEvidence(tx, evidence, evidence.createId, input.self);
    }));
  await projectAfterWrite(store, room.id);
}
