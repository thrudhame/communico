// Rebuild a semantic room manifest with the existing admission, ingest and
// history owners. Source row IDs and source verdicts never become local truth.
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Store } from '#engine/store/index.ts';
import { assertAcl } from './acl.ts';
import { roomCreateId, roomVersionOf } from './build.ts';
import type { Fetcher, KeyResolver } from './deps.ts';
import { backfill } from './history.ts';
import { afterRoomCommit, ingestInTx } from './ingest.ts';
import { openRoom } from './index.ts';
import { withRoomLock } from './lock.ts';
import { importReplicaBoundary, importReplicaGenesis } from './replica.ts';
import type { ReplicaRoom } from './replica-export.ts';
import { stageSnapshotEvidence } from './snapshot-install.ts';
import { verifySnapshot } from './snapshot.ts';
import { prepareReceiptPack, type Verified, verify } from './verify.ts';
import {
  prepareEventSignatures,
  type SignatureEvidence,
} from './signatures.ts';

function unavailable(message: string): never {
  throw new MatrixError(503, 'M_UNAVAILABLE', message);
}

export async function importReplicaRoom(
  store: Store,
  manifest: ReplicaRoom,
  input: {
    self: string;
    keys: KeyResolver;
    signal?: AbortSignal;
    signatureUnion?: boolean;
    home?: boolean;
    admit?: () => void;
  },
): Promise<void> {
  if (manifest.version !== 1) {
    throw new MatrixError(400, 'M_BAD_JSON', 'replica manifest version');
  }
  const roomHandle = () =>
    openRoom(store, manifest.roomId, { admit: input.admit });
  if (manifest.after > 0) await roomHandle();
  const residents = new Map(Object.entries(manifest.residents));
  const pack = new Map<string, Pdu>();
  const signatures = new Map<string, SignatureEvidence>();
  const receipts = await prepareReceiptPack(manifest.events, async (raw) => {
    input.signal?.throwIfAborted();
    const options = {
      roomId: manifest.roomId,
      signal: input.signal,
      exemptPrevAuthLimits: true,
      localSnapshotFallback: residents.has(String(raw.event_id))
        ? { self: input.self, resident: residents.get(String(raw.event_id))! }
        : undefined,
    };
    let verified: Verified;
    let evidence: SignatureEvidence | undefined;
    if (input.signatureUnion) {
      const prepared = await prepareEventSignatures(
        raw,
        manifest.roomVersion,
        input.keys,
        options,
      );
      evidence = prepared.evidence;
      verified = prepared;
    } else {
      verified = await verify(raw, manifest.roomVersion, input.keys, options);
    }
    return { raw, verified, evidence };
  });
  for (const { raw, verified, evidence } of receipts) {
    if (raw.event_id !== verified.eventId || pack.has(verified.eventId)) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'replica event identity collision',
      );
    }
    if (evidence) signatures.set(verified.eventId, evidence);
    pack.set(verified.eventId, verified.pdu);
  }
  const event = (id: string): Pdu =>
    pack.get(id) ?? unavailable('replica event is unavailable');
  // Keep the compact wire descriptions, not a complete state/auth copy per
  // join. Validate all references and removals before any room effects, then
  // materialize only the boundary requested by a snapshot consumer.
  const boundaries = new Map<string, ReplicaRoom['boundaries'][number]>();
  const contains = (
    boundary: ReplicaRoom['boundaries'][number],
    field: 'state' | 'authChain',
    id: string,
  ): boolean => {
    for (;;) {
      if (boundary[field].includes(id)) return true;
      if (boundary.base === undefined) return false;
      const removed = field === 'state'
        ? boundary.removedState
        : boundary.removedAuth;
      if (removed?.includes(id)) return false;
      boundary = boundaries.get(boundary.base) ??
        unavailable('replica boundary base is unavailable');
    }
  };
  for (const boundary of manifest.boundaries) {
    if (boundaries.has(boundary.eventId)) {
      throw new MatrixError(400, 'M_BAD_JSON', 'duplicate replica boundary');
    }
    if (boundary.base === undefined) {
      boundaries.set(boundary.eventId, boundary);
      continue;
    }
    const base = boundaries.get(boundary.base);
    if (!base) unavailable('replica boundary base is unavailable');
    for (
      const [field, removed] of [
        ['state', boundary.removedState ?? []],
        ['authChain', boundary.removedAuth ?? []],
      ] as const
    ) {
      const seen = new Set<string>();
      for (const id of removed) {
        if (seen.has(id) || !contains(base, field, id)) {
          throw new MatrixError(
            400,
            'M_BAD_JSON',
            'replica removes unknown boundary event',
          );
        }
        seen.add(id);
      }
    }
    boundaries.set(boundary.eventId, boundary);
  }
  const expandedBoundary = (id: string) => {
    let boundary = boundaries.get(id);
    if (!boundary) return undefined;
    // Preserve complete-list ordering/duplicates for the existing snapshot
    // verifier. Only a delta has set semantics in the original wire contract.
    if (boundary.base === undefined) return boundary;
    const chain = [boundary];
    while (boundary.base !== undefined) {
      boundary = boundaries.get(boundary.base) ??
        unavailable('replica boundary base is unavailable');
      chain.push(boundary);
    }
    const state = new Set<string>(), auth = new Set<string>();
    for (let i = chain.length - 1; i >= 0; i--) {
      const part = chain[i];
      if (part.base !== undefined) {
        for (const event of part.removedState ?? []) state.delete(event);
        for (const event of part.removedAuth ?? []) auth.delete(event);
      }
      for (const event of part.state) state.add(event);
      for (const event of part.authChain) auth.add(event);
    }
    return {
      ...chain[0],
      state: [...state].sort(),
      authChain: [...auth].sort(),
    };
  };
  const snapshot = (id: string) => {
    const boundary = expandedBoundary(id);
    if (!boundary) unavailable('replica before-state is unavailable');
    return {
      resident: boundary.resident,
      residents,
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
      const boundary = expandedBoundary(id);
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
  const first = manifest.stays[0];
  if (!first) unavailable('replica has no participation');
  const verifyPack = () =>
    verifySnapshot({
      ...input,
      roomId: manifest.roomId,
      roomVersion: manifest.roomVersion,
      resident: input.self,
      residents,
      state: [event(first.opening.createId)],
      authChain: [...pack.values()],
    });
  // Verification using a declared version is not proof that it is the room's
  // version. Authenticate the signed create before any v2 evidence can commit.
  const packEvidence = input.signatureUnion ? await verifyPack() : undefined;
  const initialized = new Set<string>();
  // Known auth/genesis events and signature-only packs need the same immutable
  // material comparison as live steps. Validate them before bootstrap writes.
  if (packEvidence && (await store.rooms()).includes(manifest.roomId)) {
    const room = await roomHandle();
    await withRoomLock(room.id, () =>
      room.tx(async (tx) => {
        const stay = await tx.segments.latestStay();
        if (stay && await roomCreateId(tx, stay.id) !== packEvidence.createId) {
          throw new MatrixError(
            400,
            'M_BAD_JSON',
            'replica replaces retained room create',
          );
        }
        await tx.events.list([...signatures.keys()]);
        for (const evidence of signatures.values()) {
          await tx.events.mergeSignatures(evidence, input.home);
        }
      }));
  }
  const ensure = async (id: string) => {
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
        join: event(id),
        reconcile: input.signatureUnion,
        ...snapshot(id),
      });
    }
    initialized.add(id);
  };
  for (let i = 0; i < manifest.steps.length;) {
    input.signal?.throwIfAborted();
    const step = manifest.steps[i];
    await ensure(step.stay);
    const room = await roomHandle();
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
        self: input.self,
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
    if (
      input.signatureUnion &&
      await room.tx((tx) => tx.segments.openStay()) === null &&
      (await room.tx((tx) => tx.events.getStatus(step.eventId)))?.grounding !==
        'grounded'
    ) {
      // A source stay may never have closed. Its next logical-local join is
      // still authentic participation for this receiver. Install that verified
      // boundary before suffix admission, without discarding our archived DAG.
      let candidate: ReplicaRoom['steps'][number] | undefined;
      for (const entry of manifest.steps) {
        const pdu = event(entry.eventId);
        if (
          entry.kind === 'live' && boundaries.has(entry.eventId) &&
          pdu.type === 'm.room.member' && pdu.state_key === pdu.sender &&
          domainOf(pdu.sender) === input.self &&
          pdu.content?.membership === 'join' &&
          (await room.tx((tx) => tx.events.getStatus(entry.eventId)))
              ?.grounding !== 'grounded'
        ) {
          candidate = entry;
          break;
        }
      }
      if (!candidate) unavailable('replica live participation is unavailable');
      await importReplicaBoundary(store, {
        ...input,
        roomId: manifest.roomId,
        roomVersion: manifest.roomVersion,
        join: event(candidate.eventId),
        reconcile: true,
        ...snapshot(candidate.eventId),
      });
    }
    const pdu = event(step.eventId);
    const verified = await verify(pdu, manifest.roomVersion, input.keys, {
      roomId: manifest.roomId,
    });
    const boundary = boundaries.has(step.eventId)
      ? await verifySnapshot({
        ...input,
        roomId: manifest.roomId,
        roomVersion: manifest.roomVersion,
        ...snapshot(step.eventId),
      })
      : undefined;
    await withRoomLock(room.id, () =>
      room.tx(async (tx) => {
        if (input.signatureUnion) {
          await tx.events.mergeSignatures(
            signatures.get(step.eventId)!,
            input.home,
          );
        } else {
          const existing = await tx.events.get(step.eventId);
          if (
            existing &&
            canonicalJson(JSON.parse(existing.pdu)) !==
              canonicalJson(verified.pdu)
          ) {
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
          await stageSnapshotEvidence(tx, boundary, step.eventId);
        }
        const result = await ingestInTx(tx, room.id, verified.pdu, {
          remote: {
            origin: step.origin,
            self: input.self,
            oversized: verified.oversized,
            ungroundedMs: 0,
            promoteEvidence: true,
            boundary: boundary?.snapshot,
          },
        });
        if (result.grounding !== 'grounded') {
          unavailable('replica live event did not ground');
        }
      }));
    await afterRoomCommit(room, input.self);
  }
  for (const [id, expected] of stays) {
    if (!initialized.has(id)) {
      await ensure(id);
    }
    const room = await roomHandle();
    const closed = await room.tx(async (tx) => {
      const stay = (await tx.segments.list()).find((held) =>
        held.kind === 'stay' &&
        (expected.opening.kind === 'genesis'
          ? held.opened_by === null
          : held.opened_by === id)
      );
      return stay?.status === 'closed';
    });
    if (!input.signatureUnion && closed !== expected.closed) {
      unavailable('replica participation cut is incomplete');
    }
  }
  // Retain outlier/pending bytes as independently auth-checked evidence, not
  // copied source status or live publication. Later source transitions can
  // ground them normally. This also works after the final stay has closed.
  const evidence = packEvidence ?? await verifyPack();
  const room = await roomHandle();
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
      await stageSnapshotEvidence(tx, evidence, evidence.createId);
    }));
  await afterRoomCommit(room, input.self);
}
