// api/engine/room/index.ts — the typed room handle: one room file, one
// transaction per tx() call, every data operation exposed inside it under
// its module's short name. The store must have been opened with the room
// schema provider (R14).
import type { Store } from '#engine/store/index.ts';
import type { ErasureCut } from '#engine/room/state.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import * as changes from '#engine/room/changes.ts';
import * as events from '#engine/room/events.ts';
import { type EdgeOverlay, roomEdges } from '#engine/room/edges.ts';
import * as extremities from '#engine/room/extremities.ts';
import * as materialize from '#engine/room/materialize.ts';
import * as segments from '#engine/room/segments.ts';
import { roomSchema } from '#engine/room/schema.ts';
import * as state from '#engine/room/state.ts';
import * as waits from '#engine/room/waits.ts';
import * as remoteBatches from '#engine/room/remote-batches.ts';
import * as membershipReceipts from '#engine/room/membership-receipts.ts';
import * as completion from '#engine/room/completion.ts';
import type { RemoteOutcome } from '#engine/room/remote.ts';
import { orderKeys } from '#engine/room/topology.ts';

export { roomSchema };
export { formatCursor, parseCursor } from '#engine/room/segments.ts';
export type { WalkCursor, WalkStep } from '#engine/room/segments.ts';
export type { EventRow, Status, Walk } from '#engine/room/events.ts';
export type { StateChange, StateMap } from '#engine/room/state.ts';
export type { Segment } from '#engine/room/segments.ts';
export type { Wait } from '#engine/room/waits.ts';
export type { Change } from '#engine/room/changes.ts';

// Count only resolutions in committed attempts, not abandoned snapshots.
export const resolutionProbe = { resolutions: 0 };

function bind(
  conn: Conn,
  roomId: string,
  edges: EdgeOverlay,
  groups: state.StateGroups,
  rows: events.EventReads,
) {
  return {
    diagnostics: { resolutions: 0 },
    completion: {
      state: () => completion.completionState(conn),
      capture: () => completion.captureCompletionCut(conn, roomId),
      receipt: (eventId: string) =>
        completion.completionReceipt(conn, roomId, eventId),
      record: (eventId: string) =>
        completion.recordCompletion(conn, roomId, eventId),
      reconcileLegacy: (eventId: string) =>
        completion.reconcileLegacyCompletion(conn, roomId, eventId),
      validate: (
        target: completion.CompletionCut | completion.CompletionTarget,
      ) => {
        if (target.roomId !== roomId) throw new Error('E_COMPLETION_ROOM');
        return 'eventId' in target
          ? completion.validateCompletion(conn, target)
          : completion.validateCompletionCut(conn, target);
      },
      complete: (generation: string, through: number) =>
        completion.markCompleted(conn, generation, through),
    },
    membershipReceipts: {
      get: (operation: string, inputHash: string) =>
        membershipReceipts.membershipReceipt(conn, operation, inputHash),
      save: (
        operation: string,
        inputHash: string,
        result: Record<string, unknown>,
      ) =>
        membershipReceipts.saveMembershipReceipt(
          conn,
          operation,
          inputHash,
          result,
        ),
    },
    remoteBatches: {
      get: (operationId: string, inputHash: string) =>
        remoteBatches.remoteBatch(conn, operationId, inputHash),
      save: (
        operationId: string,
        inputHash: string,
        outcomes: RemoteOutcome[],
      ) =>
        remoteBatches.saveRemoteBatch(conn, operationId, inputHash, outcomes),
    },
    events: {
      insert: async (
        id: string,
        pdu: string | import('#engine/pdu.ts').Pdu,
      ) => {
        await events.insertEvent(conn, id, pdu, edges);
        await waits.readyFor(conn, id);
      },
      get: (id: string) => rows.get(id),
      list: (ids: readonly string[]) => rows.list(ids),
      mergeSignatures: async (
        evidence: import('./signatures.ts').SignatureEvidence,
      ) => {
        if (!await events.mergeEventSignatures(conn, rows, evidence)) {
          return false;
        }
        await changes.appendChange(conn, 'signature', evidence.eventId, {});
        return true;
      },
      ancestry: (ids: readonly string[]) => events.ancestryNodes(conn, ids),
      prevsOf: (event: string) => events.prevsOf(conn, event, edges),
      authsOf: (event: string) => events.authsOf(conn, event, edges),
      childrenOf: (prev: string) => events.childrenOf(conn, prev),
      orderKeys: (ids: readonly string[]) => orderKeys(conn, ids),
      authChildrenOf: (auth: string) => events.authChildrenOf(conn, auth),
      authClosure: (seeds: readonly string[], limit: number) =>
        events.authClosure(conn, seeds, limit, edges),
      ancestors: (
        seeds: readonly string[],
        stopAt: readonly string[],
        limit: number,
      ) => events.ancestors(conn, seeds, stopAt, limit, edges),
      getStatus: (event: string) => events.getStatus(conn, event),
      setStatus: async (event: string, status: events.Status) => {
        await events.setStatus(conn, event, status);
        await waits.readyFor(conn, event);
      },
      statuses: (ids: readonly string[]) => events.statuses(conn, ids),
      missingCandidates: (
        latest: readonly string[],
        earliest: readonly string[],
        minimumDepth: number,
        limit: number,
      ) =>
        events.missingCandidates(conn, latest, earliest, minimumDepth, limit),
      timestampBucket: (ts: number, dir: 'f' | 'b', inclusive: boolean) =>
        events.timestampBucket(conn, ts, dir, inclusive),
      hasAnnotation: (
        target: string,
        type: string,
        sender: string,
        key: string,
      ) => events.hasAnnotation(conn, target, type, sender, key),
    },
    state: {
      groupEntries: (group: number) => groups.entries(group),
      groupMap: (group: number) => groups.map(group),
      groupKey: (group: number, type: string, stateKey: string) =>
        groups.key(group, type, stateKey),
      eventStateBefore: (event: string) => state.eventStateBefore(conn, event),
      eventStateAfter: (event: string) => state.eventStateAfter(conn, event),
      eventReadState: (event: string) => state.eventReadState(conn, event),
      publishedGroupsAfter: (event: string, cut?: ErasureCut) =>
        state.publishedGroupsAfter(conn, event, cut),
      hasJoinedBefore: (userId: string, changePos: number) =>
        state.hasJoinedBefore(conn, userId, changePos),
      participationAt: (userId: string, through: number, stay: number) =>
        state.participationAt(conn, userId, through, stay),
      membershipInterrupted: (userId: string, after: number, through: number) =>
        state.membershipInterrupted(conn, userId, after, through),
      erasureCut: () => state.erasureCut(conn),
      changedByOther: (
        type: string,
        stateKey: string,
        sender: string,
        after: number,
        initial: string | null,
      ) => state.changedByOther(conn, type, stateKey, sender, after, initial),
      publishedAt: (stay: number, pos: number) =>
        state.publishedAt(conn, stay, pos),
      current: (stay: number) => state.current(conn, stay),
    },
    materialize: {
      newGroup: (parent: number | null, batch: state.StateChange[]) =>
        materialize.newGroup(conn, parent, batch),
      setEventState: (
        event: string,
        before: number | null,
        after: number | null,
        provenance: materialize.Provenance,
      ) => materialize.setEventState(conn, event, before, after, provenance),
      publish: (changePos: number, stay: number, group: number) =>
        materialize.publish(conn, changePos, stay, group),
      setCurrent: (stay: number, group: number) =>
        materialize.setCurrent(conn, stay, group),
    },
    segments: {
      create: (options: {
        kind: 'stay' | 'history' | 'anchor';
        prev?: number | null;
        opened_by?: string | null;
        opening_group?: number | null;
        status?: string;
      }) => segments.createSegment(conn, options),
      close: (id: number) => segments.closeSegment(conn, id),
      setOpenedBy: (id: number, event: string) =>
        segments.setOpenedBy(conn, id, event),
      get: (id: number) => segments.getSegment(conn, id),
      list: () => segments.listSegments(conn),
      openStay: () => segments.openStay(conn),
      historyOf: (stay: number) => segments.historyOf(conn, stay),
      latestStay: () => segments.latestStay(conn),
      positionOf: (event: string) => segments.positionOf(conn, event),
      appendPosition: (segment: number, event: string) =>
        segments.appendPosition(conn, segment, event),
      prependPositions: (segment: number, ids: readonly string[]) =>
        segments.prependPositions(conn, segment, ids),
      positionsPage: (
        segment: number,
        from: number,
        dir: 'f' | 'b',
        limit: number,
      ) => segments.positionsPage(conn, segment, from, dir, limit),
      walkStart: () => segments.walkStart(conn),
      step: (cursor: segments.WalkCursor, dir: 'f' | 'b') =>
        segments.stepPosition(conn, cursor, dir),
      page: (cursor: segments.WalkCursor, dir: 'f' | 'b', size: number) =>
        segments.pagePositions(conn, cursor, dir, size),
      nextStayOf: (stay: number) => segments.nextStayOf(conn, stay),
    },
    extremities: {
      frontier: (stay: number) => extremities.frontier(conn, stay),
      parents: (stay: number) => extremities.parents(conn, stay),
      inherit: (previous: number, stay: number) =>
        extremities.inherit(conn, previous, stay),
      add: (stay: number, event: string) =>
        extremities.addExtremity(conn, stay, event),
      remove: (stay: number, ids: readonly string[]) =>
        extremities.removeExtremities(conn, stay, ids),
    },
    waits: {
      add: (wait: waits.Wait) => waits.addWait(conn, wait),
      for: (missing: string) => waits.waitsFor(conn, missing),
      of: (waiting: string) => waits.waitsOf(conn, waiting),
      all: () => waits.allWaits(conn),
      ready: () => waits.readyWaits(conn),
      arrive: (missing: string) => waits.readyFor(conn, missing),
      defer: (wait: waits.Wait) => waits.deferWait(conn, wait),
      expired: (now: number) => waits.expiredWaits(conn, now),
      remove: (missing: string, waiting: string, kind: string) =>
        waits.removeWait(conn, missing, waiting, kind),
      removeOf: (waiting: string) => waits.removeWaitsOf(conn, waiting),
    },
    changes: {
      localParticipation: async (event: string, user: string) => {
        const row = await rows.get(event);
        const status = await events.getStatus(conn, event);
        const pdu = row === null
          ? null
          : JSON.parse(row.pdu) as import('#engine/pdu.ts').Pdu;
        if (
          pdu?.type !== 'm.room.member' || pdu.sender !== user ||
          pdu.state_key !== user || pdu.content?.membership !== 'join' ||
          status?.standing !== 'accepted' || status.grounding !== 'grounded'
        ) throw new Error('E_LOCAL_PARTICIPATION_IDENTITY');
        await changes.recordLocalParticipation(conn, event, user);
      },
      head: () => changes.head(conn),
      append: (kind: string, event: string | null, data: unknown) =>
        changes.appendChange(conn, kind, event, data),
      after: (pos: number, limit: number) =>
        changes.changesAfter(conn, pos, limit),
      posOf: (event: string) => changes.changePosOf(conn, event),
      redactionOf: (event: string) => changes.redactionOf(conn, event),
    },
  };
}

export type RoomTx = ReturnType<typeof bind>;

export type Room = {
  readonly id: string;
  // The opening store — the server stage's projection hook reaches the
  // server file through it (room/hooks.ts).
  readonly store: Store;
  tx<T>(fn: (room: RoomTx) => Promise<T>): Promise<T>;
};

// Initialization runs in one transaction in the store's unpublished file.
// Only the receipt escapes; ordinary room handles open after publication.
export function initializeRoom<T>(
  store: Store,
  roomId: string,
  fn: (tx: RoomTx) => Promise<T>,
): Promise<T> {
  return roomTransaction(
    store,
    roomId,
    fn,
    (body) => store.initializeRoom(roomId, (db) => db.tx(body)),
  );
}

// One attempt owner for normal files and unpublished initialization. The
// runner resolves only after its transaction/publication boundary succeeds.
async function roomTransaction<T>(
  store: Store,
  roomId: string,
  fn: (tx: RoomTx) => Promise<T>,
  run: <R>(body: (conn: Conn) => Promise<R>) => Promise<R>,
): Promise<T> {
  const cutoff = roomEdges.cutoff();
  const { result, resolutions, edges } = await run(async (conn) => {
    const edges = roomEdges.attempt(store, roomId, cutoff);
    const groups = new state.StateGroups(conn);
    const rows = new events.EventReads(conn, edges);
    const tx = bind(conn, roomId, edges, groups, rows);
    try {
      const result = await fn(tx);
      return { result, resolutions: tx.diagnostics.resolutions, edges };
    } finally {
      // Cache hits must not let an escaped RoomTx outlive its Conn.
      edges.release();
      groups.release();
      rows.release();
    }
  });
  edges.commit();
  resolutionProbe.resolutions += resolutions;
  return result;
}

export async function openRoom(
  store: Store,
  roomId: string,
  options: { create?: boolean } = {},
): Promise<Room> {
  const db: Database = await store.room(roomId, options);
  return {
    id: roomId,
    store,
    tx: (fn) => roomTransaction(store, roomId, fn, (body) => db.tx(body)),
  };
}
