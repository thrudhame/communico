// api/engine/server/project.ts — R12: project a room's change log into the
// server file. Every change kind applies idempotently, keyed by (room, pos)
// for the derived rows and (room, pos, destination) for the outbox; the
// feed's seq is assigned here, in projection order, following each room's
// pos. The room's watermark advances in the same server transaction as each
// change's derived writes, so a crash replays no committed effects — and
// truth columns (outbox state, receipts, presence, forgotten) are never
// touched. The server file is durable truth for seq, delivery progress and
// user intent; it is never rebuilt from scratch.
//
// History is never news: history/evidence/pending events are indexed
// without a seq. Only live accepted events (positioned on a stay) enter
// the feed, live relation listings and search. Accepted historical relation
// edges remain available to the shared classifier without publishing news.
import type { Change } from '#engine/room/changes.ts';
import type {
  CompletionCut,
  CompletionTarget,
} from '#engine/room/completion.ts';
import { openRoom, type Room, type RoomTx } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { roomSource } from '#engine/store/projection-sources.ts';
import { queueBadge } from '#engine/server/push-queue.ts';
import { advance, advanceAll, get, getAll } from '#engine/store/watermark.ts';
import { changedColumns } from '#engine/store/changed.ts';
import { domainOf } from '#engine/ids.ts';
import {
  eventStreamTx,
  nextEventSeq,
  reserveEventSeqs,
} from '#engine/server/stream.ts';
import {
  hasPublicationEvents,
  insertPublicationRows,
} from './publication-rows.ts';
import { finishRoomRemoval, type Removal } from '#engine/server/removal.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { reconcileTyping } from '#engine/typing.ts';
import {
  projectReceiptGraph,
  projectReceiptGraphs,
  type ReceiptMembership,
  receiptMembership,
} from '#engine/server/receipt-frontier.ts';
import { reconcileReceiptMarks } from '#engine/server/ephemeral.ts';
import { projectRejoin, type RejoinObservation } from './membership.ts';
import {
  capturePushesAt,
  prepareCapturedPush,
  prepareCapturedPushes,
  type PushCapture,
  type PushPublication,
} from '#engine/server/push-project.ts';
import {
  applyPushPublication,
  captureIndependentPushes,
  reconcileNotificationEvent,
  reconcileNotificationReads,
} from '#engine/server/notifications.ts';

// The watermark source naming a room's change log (storage plan's
// sources() enumerates these; tests already use this shape).
export function sourceOf(roomId: string): string {
  return roomSource('room', roomId);
}

// Capture pagination, not writer ownership. Contention ends a transaction at
// its next complete event/effect unit; uncontended pages batch complete units.
const BATCH = 500;

// Ingest appends an event/transition and its membership, redaction and delivery
// effects together. Those rows are one publication unit, not competing writers.
// A later event/transition starts another unit even if it names the same PDU;
// standalone effects and history retain their own complete prefix semantics.
function samePublicationUnit(
  change: Change,
  next: Change | undefined,
): boolean {
  return next !== undefined && change.event !== null &&
    next.event === change.event && next.kind !== 'event' &&
    next.kind !== 'transition' && next.kind !== 'history' &&
    next.kind !== 'drop' && change.kind !== 'drop';
}

async function captureChanges(room: Room, mark: number, head: number) {
  return await room.tx(async (tx) => {
    // One lookahead identifies the page's final unit. If it crosses capture
    // pagination, finish that unit, never extending this caller's fixed cut.
    const batch = (await tx.changes.after(mark, BATCH + 1)).filter((c) =>
      c.pos <= head
    );
    let end = Math.min(BATCH, batch.length);
    while (end > 0 && samePublicationUnit(batch[end - 1], batch[end])) {
      end++;
      if (end === batch.length && batch[end - 1].pos < head) {
        batch.push(
          ...(await tx.changes.after(batch[end - 1].pos, BATCH)).filter(
            (c) => c.pos <= head,
          ),
        );
      }
    }
    return batch.slice(0, end);
  });
}

// One publication/lifecycle mutation at a time. Immutable room preparation
// belongs to each room's capture owner, never this shared writer turn. Failed
// work releases both owners for the next write or startup roll-forward.
type PublicationTurn = {
  store: Store;
  roomId: string;
  prepare: (contended: boolean) => Promise<Prepared[] | null>;
  finish: (ready: Prepared[] | null) => Promise<TurnOutcome>;
  resolve: (value: TurnOutcome) => void;
  reject: (error: unknown) => void;
  localServers: string[];
};
type TurnOutcome =
  | { kind: 'retry' }
  | { kind: 'more'; end: number; pos: number }
  | { kind: 'complete'; listeners: typeof projectedListeners };
type WriterTurn =
  | { kind: 'lifecycle'; run: () => Promise<void> }
  | { kind: 'publication'; work: PublicationTurn };
const writerQueue: WriterTurn[] = [];
let writing = false;
let waitingWriters = 0;
const roomQueues = new WeakMap<Store, Map<string, Promise<void>>>();

// Projection listeners (the federation sender's wake, 4c-2): registered
// like the room hooks, fired after each completed projection. Each emission
// owns its audience and completion, but never retains the publication lock
// while awaiting observers. One listener cannot suppress another's wake.
const projectedListeners:
  ((store: Store, roomId: string, through: number) => void | Promise<void>)[] =
    [];

export function onProjected(
  fn: (store: Store, roomId: string, through: number) => void | Promise<void>,
): () => void {
  projectedListeners.push(fn);
  return () => {
    const at = projectedListeners.indexOf(fn);
    if (at !== -1) projectedListeners.splice(at, 1);
  };
}

async function dispatchProjected(
  store: Store,
  roomId: string,
  through: number,
  audience: ReadonlyArray<(typeof projectedListeners)[number]> = [
    ...projectedListeners,
  ],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    audience.map((fn) =>
      Promise.resolve().then(() => fn(store, roomId, through))
    ),
  );
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
}

export function project(store: Store, roomId: string): Promise<void> {
  // Admission fixes this caller's obligation before an earlier room owner can
  // append more work. Keep the capability with its cut for lifecycle fencing.
  const admitted = (async () => {
    const room = await openRoom(store, roomId);
    return { room, head: await room.tx((tx) => tx.changes.head()) };
  })();
  return enqueueProjection(store, roomId, admitted);
}

/** Complete one immutable durable receipt, never recapturing today's head. */
export function projectThrough(
  store: Store,
  target: CompletionCut | CompletionTarget,
): Promise<void> {
  const admitted = (async () => {
    const room = await openRoom(store, target.roomId);
    await room.tx((tx) => tx.completion.validate(target));
    return { room, head: target.through, target };
  })();
  return enqueueProjection(store, target.roomId, admitted);
}

// The owned completion service releases publication waiters independently of
// required callbacks. Each committed prefix is observable outside the writer.
export function publishThrough(
  store: Store,
  target: CompletionCut | CompletionTarget,
  progress: () => Promise<void>,
): Promise<void> {
  const admitted = (async () => {
    const room = await openRoom(store, target.roomId);
    await room.tx((tx) => tx.completion.validate(target));
    return { room, head: target.through, target, progress };
  })();
  return enqueueProjection(store, target.roomId, admitted);
}

const completing = new WeakMap<Store, Map<string, Promise<void>>>();

function completionKey(target: CompletionCut | CompletionTarget): string {
  return JSON.stringify([target.roomId, target.generation, target.through]);
}

export function completePublished(
  store: Store,
  target: CompletionCut | CompletionTarget,
): Promise<void> {
  let active = completing.get(store);
  if (active === undefined) completing.set(store, active = new Map());
  const key = completionKey(target);
  const existing = active.get(key);
  if (existing !== undefined) {
    // Sharing callback ownership cannot share authority: validate each exact
    // receipt even if another event/cut caller already owns these callbacks.
    return openRoom(store, target.roomId).then(async (room) => {
      await room.tx((tx) => tx.completion.validate(target));
      await existing;
    });
  }
  const task = Promise.resolve().then(() => finishPublished(store, target));
  active.set(key, task);
  const release = () => {
    if (active.get(key) === task) active.delete(key);
  };
  void task.then(release, release);
  return task;
}

async function finishPublished(
  store: Store,
  target: CompletionCut | CompletionTarget,
): Promise<void> {
  const room = await openRoom(store, target.roomId);
  const completed = await room.tx(async (tx) => {
    await tx.completion.validate(target);
    return (await tx.completion.state()).completedThrough;
  });
  if (
    await get(await store.server(), sourceOf(target.roomId)) < target.through
  ) {
    throw new Error('E_COMPLETION_UNPUBLISHED: ' + target.roomId);
  }
  if (completed >= target.through) return;
  const errors = await dispatchProjected(store, target.roomId, target.through);
  if (errors.length) {
    throw new AggregateError(errors, 'E_COMPLETION_CALLBACK: ' + target.roomId);
  }
  await room.tx(async (tx) => {
    await tx.completion.validate(target);
    await tx.completion.complete(target.generation, target.through);
  });
}

function enqueueProjection(
  store: Store,
  roomId: string,
  admitted: Promise<
    {
      room: Room;
      head: number;
      target?: CompletionCut | CompletionTarget;
      progress?: () => Promise<void>;
    }
  >,
): Promise<void> {
  // A failed admission can settle while its predecessor still owns the queue.
  // The queued result below retains the rejection for the actual caller.
  void admitted.catch(() => {});
  let rooms = roomQueues.get(store);
  if (rooms === undefined) roomQueues.set(store, rooms = new Map());
  // This room's baseline has one capture owner; independent rooms prepare
  // concurrently. A failed page releases its owner for the next roll-forward.
  const run = (rooms.get(roomId) ?? Promise.resolve()).catch(() => {}).then(
    async () => {
      const { room, head, target, progress } = await admitted;
      await projectRoom(store, roomId, room, head, target, progress);
    },
  );
  rooms.set(roomId, run);
  const release = () => {
    if (rooms.get(roomId) === run) rooms.delete(roomId);
  };
  void run.then(release, release);
  return run;
}

async function projectRoom(
  store: Store,
  roomId: string,
  room: Room,
  head: number,
  target?: CompletionCut | CompletionTarget,
  progress?: () => Promise<void>,
): Promise<void> {
  const server = await store.server();
  capture: for (;;) {
    let mark = await get(server, sourceOf(roomId));
    let contextMark = await get(server, roomSource('push-context', roomId));
    let receiptMark = await get(server, roomSource('receipt-graph', roomId));
    const localServers = await store.tenants();
    // Upgrade cursors are independent, but their immutable room capture shares
    // the same outside-writer preparation and fair complete-prefix publication.
    const seed = await captureHistoricalRelations(
      room,
      mark,
      Math.min(contextMark, receiptMark),
    );
    const device = seed === null
      ? await captureDevicePublication(store, room, mark)
      : null;
    let batch = seed === null ? await captureChanges(room, mark, head) : [];
    const drop = batch.findIndex((change) => change.kind === 'drop');
    if (drop > 0) batch = batch.slice(0, drop);
    const prepared = drop === 0
      ? []
      : await prepare(room, store, roomId, batch, localServers);
    if (drop === 0) {
      // Replayed retirement completes the already published prefix BEFORE the
      // global writer/removal turn. Callbacks may themselves need that writer.
      const cut = await room.tx((tx) => tx.completion.capture());
      await completePublished(store, { ...cut, through: batch[0].pos - 1 });
    }
    const current = async () => {
      // This logical handle fences retirement and the storage incarnation.
      // A drop/recreate cannot publish an earlier incarnation's captured page.
      await room.tx(async (tx) => {
        if (target !== undefined) await tx.completion.validate(target);
      });
      const [currentMark, currentContext, currentReceipt] = await getAll(
        server,
        [
          sourceOf(roomId),
          roomSource('push-context', roomId),
          roomSource('receipt-graph', roomId),
        ],
      );
      return currentMark === mark && currentContext === contextMark &&
        currentReceipt === receiptMark;
    };
    if (seed !== null) {
      // Context edges batch until another writer needs the owner. Publish only
      // the committed prefix cursor; live work still owes the complete seed.
      let index = 0;
      do {
        const applied = await withProjectionLock(async () => {
          if (!await current()) return false;
          return await applyHistoricalRelations(server, roomId, seed, index);
        });
        if (applied === false) continue capture;
        index = applied.end;
        contextMark = Math.max(contextMark, applied.cursor);
        receiptMark = Math.max(receiptMark, applied.cursor);
      } while (index < seed.edges.length);
      continue;
    }
    // The empty turn handles upgrade seeding and completion. A removal is
    // similarly one atomic lifecycle turn, never mixed into ordinary work.
    let index = 0;
    do {
      const lifecycle = async (): Promise<TurnOutcome> => {
        if (!await current()) return { kind: 'retry' } as const;
        if (
          device !== null && !(await server.query(
            'SELECT 1 FROM e2ee_rooms WHERE room=?',
            [roomId],
          )).length
        ) {
          const captured = device;
          await server.tx((tx) =>
            applyDevicePublication(
              tx,
              roomId,
              captured.publication,
              captured.pos,
              localServers,
            )
          );
        }
        if (drop === 0) {
          await finishRoomRemoval(
            store,
            roomId,
            JSON.parse(batch[0].data) as Removal,
            batch[0].pos,
          );
        }
        if (drop !== 0 && index < prepared.length) {
          // Upgrade seeding is a boundary. Recapture its now-current baseline
          // before offering the ordinary unit to the publication queue.
          return { kind: 'retry' };
        }
        await reconcileTyping(server, roomId);
        return {
          kind: 'complete',
          listeners: [...projectedListeners],
        } as const;
      };
      // Empty/upgrade/removal work is opaque lifecycle work. Only immutable,
      // ordinary prepared units enter the coalescible queue surface.
      const outcome = seed === null && device === null && drop !== 0 &&
          index < prepared.length
        ? await new Promise<TurnOutcome>((resolve, reject) => {
          enqueueWriter({
            kind: 'publication',
            work: {
              store,
              roomId,
              localServers,
              resolve,
              reject,
              prepare: async (contended) => {
                if (!await current()) return null;
                const ready: Prepared[] = [];
                for (let at = index; at < prepared.length; at++) {
                  const item = prepared[at];
                  ready.push(
                    !contended && 'pushCapture' in item &&
                      item.pushCapture !== null
                      ? {
                        ...item,
                        push: await prepareCapturedPush(
                          store,
                          item.pushCapture,
                        ),
                      }
                      : item,
                  );
                  if (
                    (contended || waitingWriters > 0) &&
                    !samePublicationUnit(item.change, prepared[at + 1]?.change)
                  ) break;
                }
                return ready;
              },
              finish: async (ready) => {
                if (ready === null) return { kind: 'retry' };
                const end = index + ready.length;
                const pos = ready.at(-1)!.change.pos;
                if (end < prepared.length || pos < head) {
                  return { kind: 'more', end, pos };
                }
                await reconcileTyping(server, roomId);
                return { kind: 'complete', listeners: [...projectedListeners] };
              },
            },
          });
        })
        : await withProjectionLock(lifecycle);
      if (outcome.kind === 'retry') continue capture;
      await progress?.();
      if (outcome.kind === 'complete') {
        if (progress !== undefined) return;
        if (drop !== 0) {
          // Durable completion and an explicit projection pass are different
          // notifications. A repeated legacy pass still hints its captured
          // audience; target completion/retirement never replay witnessed work.
          const cut = target ??
            {
              ...await room.tx((tx) => tx.completion.capture()),
              through: head,
            };
          try {
            const completed = await room.tx((tx) => tx.completion.state());
            if (
              target === undefined &&
              (completed.completedThrough >= head ||
                completing.get(store)?.has(completionKey(cut)))
            ) {
              // An earlier callback flight has already captured its audience.
              // This pass owns its new hint audience independently, while still
              // retaining the original completion until its real settlement.
              const failures = (await Promise.all([
                dispatchProjected(store, roomId, head, outcome.listeners),
                completePublished(store, cut).then(
                  () => [],
                  (error) => [error],
                ),
              ])).flat();
              if (failures.length) {
                throw new AggregateError(
                  failures,
                  'E_PROJECTION_CALLBACK: ' + roomId,
                );
              }
            } else {
              await completePublished(store, cut);
            }
          } catch (error) {
            if (target !== undefined) throw error;
            console.error(`projection listener failed for ${roomId}:`, error);
          }
          return;
        }
        // Preserve acknowledged observer work (including rule migration) and
        // same-room ordering without blocking independent publication writers.
        const failures = await dispatchProjected(
          store,
          roomId,
          head,
          outcome.listeners,
        );
        if (target === undefined) {
          for (const error of failures) {
            console.error(`projection listener failed for ${roomId}:`, error);
          }
        }
        if (target !== undefined) {
          if (failures.length) {
            throw new AggregateError(
              failures,
              `E_COMPLETION_CALLBACK: ${roomId}/${head}`,
            );
          }
        }
        return;
      }
      index = outcome.end;
      mark = contextMark = receiptMark = outcome.pos;
    } while (index < prepared.length);
  }
}

/** Room lifecycle operations use the same serialization as projection. */
export function withProjectionLock<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    enqueueWriter({
      kind: 'lifecycle',
      run: async () => {
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      },
    });
  });
}

function enqueueWriter(turn: WriterTurn): void {
  writerQueue.push(turn);
  waitingWriters++;
  if (writing) return;
  writing = true;
  void Promise.resolve().then(drainWriter);
}

async function drainWriter(): Promise<void> {
  try {
    while (writerQueue.length) {
      const first = writerQueue.shift()!;
      waitingWriters--;
      if (first.kind === 'lifecycle') {
        await first.run();
        continue;
      }
      // Snapshot ONLY the already-ready same-Store FIFO prefix. Enqueues during
      // validation, policy reads or commit cannot enlarge this admitted group.
      const group = [first.work];
      while (
        writerQueue[0]?.kind === 'publication' &&
        writerQueue[0].work.store === first.work.store
      ) {
        group.push(
          (writerQueue.shift()! as Extract<WriterTurn, {
            kind: 'publication';
          }>).work,
        );
        waitingWriters--;
      }
      try {
        await publishGroup(group);
      } catch (error) {
        if (group.length === 1) {
          first.work.reject(error);
          continue;
        }
        // The group rolled back: no waiter, sequence or watermark was
        // acknowledged. Isolate through the same individual application path,
        // in original FIFO order, with fresh attempt/policy input for each unit.
        for (const work of group) {
          try {
            await publishGroup([work]);
          } catch (error) {
            work.reject(error);
          }
        }
      }
    }
  } finally {
    writing = false;
  }
}

async function publishGroup(group: PublicationTurn[]): Promise<void> {
  const captured: { work: PublicationTurn; ready: Prepared[] | null }[] = [];
  for (const work of group) {
    captured.push({ work, ready: await work.prepare(group.length > 1) });
  }
  const active = captured.filter((entry): entry is {
    work: PublicationTurn;
    ready: Prepared[];
  } => entry.ready !== null);
  const policies = active.flatMap(({ ready }) =>
    ready.filter((item): item is Extract<Prepared, { payload: EventPayload }> =>
      'pushCapture' in item && item.pushCapture !== null && item.push === null
    )
  );
  if (policies.length) {
    const publications = await prepareCapturedPushes(
      group[0].store,
      policies.map((p) => p.pushCapture!),
    );
    for (let at = 0; at < policies.length; at++) {
      policies[at].push = publications[at];
    }
  }
  if (active.length) {
    const server = await group[0].store.server();
    const now = Date.now();
    await eventStreamTx(server, async (tx) => {
      if (await applyIndependentPublications(tx, active, now)) return;
      for (const { work, ready } of active) {
        for (const item of ready) {
          await apply(tx, work.roomId, item, now, work.localServers);
        }
        await reconcileReceiptMarks(tx, work.roomId);
        await reconcileNotificationReads(tx, work.roomId, now);
        const pos = ready.at(-1)!.change.pos;
        await advance(tx, sourceOf(work.roomId), pos);
        await advance(tx, roomSource('push-context', work.roomId), pos);
        await advance(tx, roomSource('receipt-graph', work.roomId), pos);
      }
    });
  }
  // A post-commit typing/listener failure is this unit's failure, not grounds
  // for replaying the durable group or suppressing another room's completion.
  for (const { work, ready } of captured) {
    try {
      work.resolve(await work.finish(ready));
    } catch (error) {
      work.reject(error);
    }
  }
}

/** Plain, independent event/effect units can flush each dependency as a set.
 * Complex transitions, relation repair, replay and membership/device changes
 * keep the general ordered owner path, in the same grouped transaction. */
async function applyIndependentPublications(
  tx: Conn,
  active: { work: PublicationTurn; ready: Prepared[] }[],
  now: number,
): Promise<boolean> {
  const units: {
    work: PublicationTurn;
    ready: Prepared[];
    item: Extract<Prepared, { payload: EventPayload }>;
  }[] = [];
  for (const { work, ready } of active) {
    const item = ready[0];
    if (
      item.kind !== 'event' || !isLive(item.payload) ||
      item.payload.grounding !== 'grounded' || item.publication !== null ||
      item.relation !== null || item.push === null || item.prevs === null ||
      ready.slice(1).some((i) => i.kind !== 'delivery')
    ) return false;
    units.push({ work, ready, item });
  }
  if (await hasPublicationEvents(tx, units.map((u) => u.item.change.event!))) {
    return false;
  }
  const applyPushes = await captureIndependentPushes(
    tx,
    units.map(({ work, item }) => ({
      room: work.roomId,
      event: item.change.event!,
      pos: item.change.pos,
      publication: item.push!,
    })),
  );
  if (applyPushes === null) return false;
  const first = await reserveEventSeqs(tx, units.length);
  await insertPublicationRows(
    tx,
    'event_index',
    [
      'event',
      'room',
      'pos',
      'standing',
      'grounding',
      'reason',
      'rule',
      'origin',
      'seq',
    ],
    units.map((
      { work, item },
      at,
    ) => [
      item.change.event,
      work.roomId,
      item.change.pos,
      item.payload.standing,
      item.payload.grounding,
      item.payload.reason,
      item.payload.rule,
      item.payload.origin,
      first + at,
    ]),
  );
  await projectReceiptGraphs(
    tx,
    units.map(({ work, item }) => ({
      room: work.roomId,
      event: item.change.event!,
      prevs: item.prevs!,
      membership: item.receiptMembership,
    })),
  );
  await insertPublicationRows(
    tx,
    'feed',
    ['seq', 'room', 'pos', 'event', 'stay'],
    units.map((
      { work, item },
      at,
    ) => [
      first + at,
      work.roomId,
      item.change.pos,
      item.change.event,
      item.payload.stay,
    ]),
  );
  await insertPublicationRows(
    tx,
    'search',
    ['event', 'room', 'seq', 'key', 'sender', 'origin_ts', 'body_lower'],
    units.flatMap(({ work, item }, at) =>
      item.search === null ? [] : [[
        item.change.event,
        work.roomId,
        first + at,
        item.search.key,
        item.payload.sender,
        item.payload.origin_server_ts,
        item.search.text,
      ]]
    ),
  );
  await applyPushes(units.map((_, at) => first + at), now);
  await insertPublicationRows(
    tx,
    'outbox',
    [
      'room',
      'pos',
      'destination',
      'event',
      'state',
      'attempts',
      'next_attempt_ms',
      'added_ms',
    ],
    units.flatMap(({ work, ready }) =>
      ready.flatMap((item) =>
        item.kind !== 'delivery' ? [] : item.destinations.map((
          destination,
        ) => [
          work.roomId,
          item.change.pos,
          destination,
          item.change.event,
          'pending',
          0,
          0,
          now,
        ])
      )
    ),
  );
  await advanceAll(
    tx,
    units.flatMap(({ work, ready }) =>
      [
        sourceOf(work.roomId),
        roomSource('push-context', work.roomId),
        roomSource('receipt-graph', work.roomId),
      ].map((source): [string, number] => [source, ready.at(-1)!.change.pos])
    ),
  );
  return true;
}

async function captureDevicePublication(
  store: Store,
  room: Room,
  mark: number,
): Promise<{ publication: Publication; pos: number } | null> {
  const server = await store.server();
  // A supported schema upgrade seeds at the already projected publication,
  // not at a newer room head and not by replaying history as news.
  if (
    mark > 0 &&
    !(await server.query('SELECT 1 FROM e2ee_rooms WHERE room=?', [room.id]))
      .length
  ) {
    const cut = await server.query(
      'SELECT stay,pos FROM feed WHERE room=? AND pos<=? ORDER BY pos DESC LIMIT 1',
      [room.id, mark],
    );
    if (cut.length) {
      const publication = await room.tx(async (tx) => {
        const ids = await memberIdsAt(
          tx,
          Number(cut[0].stay),
          Number(cut[0].pos),
          true,
        );
        if (ids === null) return null;
        const members = await membersAt(tx, ids.members, new Map());
        return { ...ids, members };
      });
      if (publication !== null) return { publication, pos: Number(cut[0].pos) };
    }
  }
  return null;
}

// --- the change payloads ---------------------------------------------------

// Older schemas lacked history edges and implicit-read event identity. Recover
// those facts from immutable PDUs, then reconcile saved decisions. This never
// re-evaluates rules or replays live publication/delivery intent.
type HistoricalSeed = {
  cursor: number;
  edges: {
    event: string;
    pos: number;
    relation: { relatesTo: string; relType: string | null } | null;
    sender: string;
    seq: number | null;
    prevs: string[];
    membership: ReceiptMembership | null;
  }[];
};

async function captureHistoricalRelations(
  room: Room,
  mark: number,
  contextMark: number,
): Promise<HistoricalSeed | null> {
  if (mark === 0 || contextMark >= mark) return null;
  const server = await room.store.server();
  const page = await server.query(
    `SELECT event,pos,seq FROM event_index WHERE room=? AND pos>? AND pos<=?
      AND standing='accepted' AND grounding='grounded' ORDER BY pos LIMIT ?`,
    [room.id, contextMark, mark, BATCH],
  );
  const edges = await room.tx(async (tx) => {
    const out = [];
    for (const row of page) {
      const event = String(row.event);
      const pdu = await tx.events.get(event);
      if (pdu === null) throw new Error('projected event missing: ' + event);
      const data = JSON.parse(pdu.pdu) as Record<string, unknown>;
      out.push({
        event,
        pos: Number(row.pos),
        relation: relationOf(data, event),
        sender: String(data.sender),
        seq: row.seq === null ? null : Number(row.seq),
        prevs: await tx.events.prevsOf(event),
        membership: receiptMembership(data),
      });
    }
    return out;
  });
  return {
    edges,
    cursor: page.length < BATCH ? mark : Number(page.at(-1)!.pos),
  };
}

async function applyHistoricalRelations(
  server: Awaited<ReturnType<Store['server']>>,
  roomId: string,
  seed: HistoricalSeed,
  start: number,
): Promise<{ end: number; cursor: number }> {
  const now = Date.now();
  return await eventStreamTx(server, async (tx) => {
    let end = start;
    for (
      const { event, relation, sender, seq, prevs, membership } of seed.edges
        .slice(start)
    ) {
      await projectReceiptGraph(tx, roomId, event, prevs, membership);
      if (relation !== null) {
        await tx.execute(
          'INSERT INTO relations(event,relates_to,rel_type,room,seq) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
          [event, relation.relatesTo, relation.relType, roomId, seq],
        );
      }
      if (seq !== null) {
        await tx.execute(
          'INSERT INTO notification_own_events(room,event,user,event_seq) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
          [roomId, event, sender, seq],
        );
      }
      await reconcileNotificationEvent(tx, roomId, event, now);
      end++;
      if (waitingWriters > 0) break;
    }
    await reconcileReceiptMarks(tx, roomId);
    await reconcileNotificationReads(tx, roomId, now);
    const cursor = end === seed.edges.length
      ? seed.cursor
      : seed.edges[end - 1].pos;
    await advance(tx, roomSource('push-context', roomId), cursor);
    await advance(tx, roomSource('receipt-graph', roomId), cursor);
    return { end, cursor };
  });
}

// The 'event'/'transition'/'history' payloads share one shape (the room's
// change log writes it verbatim; a 'transition' adds `from`, a 'history'
// names its segment instead of the stay).
type EventPayload = {
  standing: string;
  reason: string | null;
  rule: string | null;
  type: string;
  state_key: string | null;
  sender: string;
  depth: number;
  origin_server_ts: number;
  stay: number | null;
  segment?: number | null;
  offset: number | null;
  grounding: string;
  origin: string | null;
};

type Prepared =
  & { change: Change }
  & (
    | {
      kind: 'event' | 'transition' | 'history';
      payload: EventPayload;
      prevs: string[] | null;
      receiptMembership: ReceiptMembership | null;
      relation: { relatesTo: string; relType: string | null } | null;
      search: { key: string; text: string } | null;
      // A live cut's complete published membership. Reconciliation uses
      // the server rows inside apply's transaction, including earlier
      // changes in the same batch. Evidence/history carry no publication.
      publication: Publication | null;
      push: PushPublication | null;
      pushCapture: PushCapture | null;
    }
    | {
      kind: 'membership';
      user: string;
      to: string | null;
      toId: string | null;
    }
    | { kind: 'redaction'; target: string }
    | { kind: 'delivery'; destinations: string[] }
    | { kind: 'signature' }
    | { kind: 'local-participation'; user: string }
    | { kind: 'rejoin-observation'; observation: RejoinObservation }
  );

function eventPayloadOf(change: Change): EventPayload {
  const data = JSON.parse(change.data) as EventPayload;
  if (typeof data.standing !== 'string' || typeof data.type !== 'string') {
    throw new Error(
      `malformed ${change.kind} change at pos ${change.pos}: ${change.data}`,
    );
  }
  return data;
}

// Live and positioned: the events that enter the feed, relations and
// search. Exactly the accepted events (the room positions no other).
function isLive(payload: EventPayload): boolean {
  return payload.standing === 'accepted' && payload.stay !== null;
}

type PublishedMember = { user: string; to: string; toId: string };
type Publication = {
  members: PublishedMember[];
  encryption: string | null;
  encrypted: boolean;
};

// A plain message with unchanged publication does no membership work.
// Offset zero is the stay's first live position, whose opening boundary
// still needs projection even if the room read fallback has the same group.
async function memberIdsAt(
  tx: RoomTx,
  stay: number | null,
  pos: number,
  first: boolean,
): Promise<
  {
    members: Map<string, string>;
    encryption: string | null;
    encrypted: boolean;
  } | null
> {
  if (stay === null) return null;
  const group = await tx.state.publishedAt(stay, pos);
  if (group === null) return null;
  if (!first && group === await tx.state.publishedAt(stay, pos - 1)) {
    return null;
  }
  const map = await tx.state.groupMap(group);
  const prefix = 'm.room.member\0';
  const encryption = map.get('m.room.encryption\0') ?? null;
  const key = encryption === null ? null : await tx.events.get(encryption);
  const algorithm = key === null
    ? null
    : (JSON.parse(key.pdu) as Pdu).content?.algorithm;
  return {
    encryption,
    encrypted: typeof algorithm === 'string' && algorithm.length > 0,
    members: new Map(
      [...map].filter(([key]) => key.startsWith(prefix)).map(
        ([key, event]) => [key.slice(prefix.length), event],
      ),
    ),
  };
}

// The baseline is the actual projected rows plus prior publications in
// this batch. Immutable member events only need reading when their id moved.
async function membersAt(
  tx: RoomTx,
  ids: Map<string, string>,
  projected: Map<string, PublishedMember>,
): Promise<PublishedMember[]> {
  const out: PublishedMember[] = [];
  for (const [user, toId] of ids) {
    const prior = projected.get(user);
    if (prior?.toId === toId) {
      out.push(prior);
      continue;
    }
    const row = await tx.events.get(toId);
    if (row === null) {
      throw new Error(`published member event missing: ${toId}`);
    }
    const membership = (JSON.parse(row.pdu) as Pdu).content?.membership;
    const to = typeof membership === 'string' ? membership : 'leave';
    out.push({ user, to, toId });
  }
  return out;
}

// The read phase on the room file: every fact the server transaction
// needs, resolved against the (immutable) change positions of this batch.
async function prepare(
  room: Room,
  store: Store,
  roomId: string,
  batch: Change[],
  localServers: string[],
): Promise<Prepared[]> {
  if (batch.length === 0) return [];
  // The triggers of membership changes whose own event change sits in an
  // earlier batch: their feed rows are already committed in the server
  // file. The batch's own event changes resolve from the batch itself.
  const inBatch = new Map<string, { pos: number; stay: number }>();
  for (const change of batch) {
    if (
      (change.kind === 'event' || change.kind === 'transition') &&
      change.event !== null
    ) {
      const payload = eventPayloadOf(change);
      if (payload.stay !== null) {
        inBatch.set(change.event, { pos: change.pos, stay: payload.stay });
      }
    }
  }
  // Cross-file positions are captured before entering the room attempt.
  for (const change of batch) {
    if (
      change.kind !== 'membership' || change.event === null ||
      inBatch.has(change.event)
    ) continue;
    const data = JSON.parse(change.data) as { user?: unknown; to?: unknown };
    if (typeof data.user !== 'string' || typeof data.to !== 'string') continue;
    const server = await store.server();
    const rows = await server.query(
      'SELECT pos, stay FROM feed WHERE room = ? AND event = ?',
      [roomId, change.event],
    );
    if (rows.length > 0) {
      inBatch.set(change.event, {
        pos: Number(rows[0].pos),
        stay: Number(rows[0].stay),
      });
    }
  }
  const { prepared: out, publications } = await room.tx(async (tx) => {
    const out: Prepared[] = [];
    const publications: {
      index: number;
      ids: NonNullable<Awaited<ReturnType<typeof memberIdsAt>>>;
    }[] = [];
    for (const change of batch) {
      switch (change.kind) {
        case 'event':
        case 'transition':
        case 'history': {
          if (change.event === null) {
            throw new Error(`${change.kind} change without an event id`);
          }
          const payload = eventPayloadOf(change);
          let relation: { relatesTo: string; relType: string | null } | null =
            null;
          let search: { key: string; text: string } | null = null;
          let prevs: string[] | null = null;
          let member: ReceiptMembership | null = null;
          if (
            payload.standing === 'accepted' && payload.grounding === 'grounded'
          ) {
            const row = await tx.events.get(change.event);
            const pdu = row === null
              ? null
              : JSON.parse(row.pdu) as Record<string, unknown>;
            if (pdu !== null) {
              prevs = await tx.events.prevsOf(change.event);
              member = receiptMembership(pdu);
              relation = relationOf(pdu, change.event);
              if (change.kind !== 'history' && isLive(payload)) {
                search = searchTextOf(payload, pdu);
              }
            }
          }
          const ids = change.kind !== 'history' && isLive(payload)
            ? await memberIdsAt(
              tx,
              payload.stay,
              change.pos,
              payload.offset === 0,
            )
            : null;
          if (ids !== null) {
            publications.push({ index: out.length, ids });
          }
          out.push({
            change,
            kind: change.kind,
            payload,
            prevs,
            receiptMembership: member,
            relation,
            search,
            publication: null,
            push: null,
            pushCapture: null,
          });
          break;
        }
        case 'rejoin-observation': {
          const observation = JSON.parse(change.data) as RejoinObservation;
          const row = change.event === null
            ? null
            : await tx.events.get(change.event);
          const status = change.event === null
            ? null
            : await tx.events.getStatus(change.event);
          const pdu = row === null ? null : JSON.parse(row.pdu) as Pdu;
          if (
            pdu?.type !== 'm.room.member' || pdu.sender !== observation.user ||
            pdu.state_key !== observation.user ||
            pdu.content?.membership !== 'join' ||
            status?.standing !== 'accepted' || status.grounding !== 'grounded'
          ) throw new Error('invalid rejoin observation');
          out.push({ change, kind: 'rejoin-observation', observation });
          break;
        }
        case 'local-participation': {
          const data = JSON.parse(change.data) as { user?: unknown };
          const row = change.event === null
            ? null
            : await tx.events.get(change.event);
          const status = change.event === null
            ? null
            : await tx.events.getStatus(change.event);
          const pdu = row === null ? null : JSON.parse(row.pdu) as Pdu;
          if (
            typeof data.user !== 'string' || pdu?.type !== 'm.room.member' ||
            pdu.sender !== data.user || pdu.state_key !== data.user ||
            pdu.content?.membership !== 'join' ||
            status?.standing !== 'accepted' || status.grounding !== 'grounded'
          ) throw new Error('E_LOCAL_PARTICIPATION_IDENTITY');
          out.push({ change, kind: 'local-participation', user: data.user });
          break;
        }
        case 'signature': {
          if (
            change.event === null || await tx.events.get(change.event) === null
          ) {
            throw new Error('signature change without a retained event');
          }
          out.push({ change, kind: 'signature' });
          break;
        }
        case 'membership': {
          if (change.event === null) {
            throw new Error('membership change without an event id');
          }
          const data = JSON.parse(change.data) as {
            user?: unknown;
            to?: unknown;
          };
          if (typeof data.user !== 'string') {
            throw new Error(
              `malformed membership change at pos ${change.pos}: ${change.data}`,
            );
          }
          const to = typeof data.to === 'string' ? data.to : null;
          // The published member event of `to` (the old fold's own event):
          // the publication at the trigger's event-change position. The
          // trigger's (stay, pos) comes from this batch or — already
          // projected — from its feed row.
          let toId: string | null = null;
          if (to !== null) {
            const at = inBatch.get(change.event) ?? null;
            if (at !== null) {
              const group = await tx.state.publishedAt(at.stay, at.pos);
              toId = group === null ? null : await tx.state.groupKey(
                group,
                'm.room.member',
                data.user,
              );
            }
          }
          out.push({ change, kind: 'membership', user: data.user, to, toId });
          break;
        }
        case 'redaction': {
          const data = JSON.parse(change.data) as { target?: unknown };
          if (typeof data.target !== 'string') {
            throw new Error(
              `malformed redaction change at pos ${change.pos}: ${change.data}`,
            );
          }
          out.push({ change, kind: 'redaction', target: data.target });
          break;
        }
        case 'delivery': {
          const data = JSON.parse(change.data) as { destinations?: unknown };
          if (!Array.isArray(data.destinations)) {
            throw new Error(
              `malformed delivery change at pos ${change.pos}: ${change.data}`,
            );
          }
          out.push({
            change,
            kind: 'delivery',
            destinations: data.destinations.map((d) => String(d)),
          });
          break;
        }
        default:
          throw new Error(
            `unknown change kind ${
              JSON.stringify(change.kind)
            } at pos ${change.pos}`,
          );
      }
    }
    // A page shares the room attempt's immutable state reconstruction. Tenant
    // policy remains fresh inside each later publication turn, never here.
    const live = out.filter((
      item,
    ): item is Extract<Prepared, { payload: EventPayload }> =>
      (item.kind === 'event' || item.kind === 'transition') &&
      isLive(item.payload)
    );
    if (localServers.length > 0 && live.length > 0) {
      const captures = await capturePushesAt(
        tx,
        roomId,
        live.map((item) => ({
          eventId: item.change.event!,
          stay: item.payload.stay!,
          pos: item.change.pos,
        })),
        localServers,
      );
      for (let at = 0; at < live.length; at++) {
        live[at].pushCapture = captures[at];
      }
    }
    return { prepared: out, publications };
  });
  // Only publication changes need a server baseline. No server/tenant I/O is
  // nested inside either room attempt, and retry-local baselines never escape.
  if (publications.length > 0) {
    const server = await store.server();
    const rows = await server.query(
      'SELECT user, membership, event FROM memberships WHERE room = ?',
      [roomId],
    );
    const completed = await room.tx(async (tx) => {
      let projected = new Map(rows.map((row) => [String(row.user), {
        user: String(row.user),
        to: String(row.membership),
        toId: String(row.event),
      }]));
      const completed: { index: number; publication: Publication }[] = [];
      for (const { index, ids } of publications) {
        const members = await membersAt(tx, ids.members, projected);
        completed.push({ index, publication: { ...ids, members } });
        projected = new Map(members.map((member) => [member.user, member]));
      }
      return completed;
    });
    for (const { index, publication } of completed) {
      const item = out[index];
      if ('publication' in item) item.publication = publication;
    }
  }
  return out;
}

// D7: the relations index takes content['m.relates_to'] with a direct
// event_id; rich replies carry theirs under m.in_reply_to instead and are
// NOT relations rows (the old condition, ported verbatim).
function relationOf(
  pdu: Record<string, unknown>,
  eventId: string,
): { relatesTo: string; relType: string | null } | null {
  const content = pdu.content;
  if (
    content === null || typeof content !== 'object' || Array.isArray(content)
  ) {
    return null;
  }
  const relatesTo = (content as Record<string, unknown>)['m.relates_to'];
  if (
    relatesTo === null || typeof relatesTo !== 'object' ||
    Array.isArray(relatesTo)
  ) {
    return null;
  }
  const target = (relatesTo as Record<string, unknown>).event_id;
  if (typeof target !== 'string' || target.length === 0 || target === eventId) {
    return null;
  }
  const relType = (relatesTo as Record<string, unknown>).rel_type;
  if (typeof relType !== 'string' || relType.length === 0) return null;
  return {
    relatesTo: target,
    relType,
  };
}

// D1: the indexed search text — body/name/topic only, lower-cased with
// NUL → space (the old ingest's searchTextOf, ported verbatim).
function searchTextOf(
  payload: EventPayload,
  pdu: Record<string, unknown>,
): { key: string; text: string } | null {
  const content = pdu.content;
  if (
    content === null || typeof content !== 'object' || Array.isArray(content)
  ) {
    return null;
  }
  const record = content as Record<string, unknown>;
  let key: string | null = null;
  let raw: string | null = null;
  if (payload.type === 'm.room.message' && typeof record.body === 'string') {
    key = 'content.body';
    raw = record.body;
  } else if (
    payload.type === 'm.room.name' && typeof record.name === 'string'
  ) {
    key = 'content.name';
    raw = record.name;
  } else if (payload.type === 'm.room.topic') {
    raw = topicTextOf(record);
    if (raw !== null) key = 'content.topic';
  }
  if (key === null || raw === null) return null;
  return { key, text: raw.replaceAll('\u0000', ' ').toLowerCase() };
}

function topicTextOf(content: Record<string, unknown>): string | null {
  const mTopic = content['m.topic'];
  if (mTopic !== null && typeof mTopic === 'object' && !Array.isArray(mTopic)) {
    const mText = (mTopic as Record<string, unknown>)['m.text'];
    if (Array.isArray(mText)) {
      for (const entry of mText) {
        if (
          entry === null || typeof entry !== 'object' || Array.isArray(entry)
        ) continue;
        const rec = entry as Record<string, unknown>;
        if (typeof rec.body !== 'string') continue;
        if (rec.mimetype === undefined || rec.mimetype === 'text/plain') {
          return rec.body;
        }
      }
    }
  }
  return typeof content.topic === 'string' ? content.topic : null;
}

// --- the application -------------------------------------------------------

async function apply(
  tx: Conn,
  roomId: string,
  item: Prepared,
  addedMs: number,
  localServers: string[],
): Promise<void> {
  const { change } = item;
  switch (item.kind) {
    case 'rejoin-observation':
      for (const self of localServers) {
        if (item.observation.user.endsWith(':' + self)) {
          await projectRejoin(
            tx,
            roomId,
            change.event!,
            item.observation,
            self,
          );
        }
      }
      return;
    case 'local-participation':
      await tx.execute(
        'UPDATE event_index SET local_join_user=? WHERE room=? AND event=? AND local_join_user IS NOT ?',
        [item.user, roomId, change.event, item.user],
      );
      return;
    // Signature evidence is export intent, never a new event, feed row, push,
    // membership transition or independent federation delivery obligation.
    case 'signature':
      return;
    case 'event': {
      await tx.execute(
        `INSERT INTO event_index(event, room, pos, standing, grounding, reason, rule, origin, seq)
         VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(event) DO NOTHING`,
        [
          change.event,
          roomId,
          change.pos,
          item.payload.standing,
          item.payload.grounding,
          item.payload.reason,
          item.payload.rule,
          item.payload.origin,
        ],
      );
      await applyReceiptGraph(tx, roomId, item);
      if (isLive(item.payload)) await applyLive(tx, roomId, item, addedMs);
      else await reconcileNotificationEvent(tx, roomId, change.event!, addedMs);
      await applyPublication(
        tx,
        roomId,
        item.payload.stay,
        change.pos,
        item.publication,
        localServers,
      );
      return;
    }
    case 'transition': {
      // the pending event's row exists; the transition lands its verdict.
      // First position wins (the row keeps its original change pos).
      await tx.execute(
        `INSERT INTO event_index(event, room, pos, standing, grounding, reason, rule, origin, seq)
         VALUES(?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(event) DO UPDATE SET
           standing = excluded.standing, grounding = excluded.grounding,
           reason = excluded.reason, rule = excluded.rule
         WHERE ${
          changedColumns(
            'event_index',
            'standing',
            'grounding',
            'reason',
            'rule',
          )
        }`,
        [
          change.event,
          roomId,
          change.pos,
          item.payload.standing,
          item.payload.grounding,
          item.payload.reason,
          item.payload.rule,
          item.payload.origin,
        ],
      );
      await applyReceiptGraph(tx, roomId, item);
      if (isLive(item.payload)) await applyLive(tx, roomId, item, addedMs);
      else await reconcileNotificationEvent(tx, roomId, change.event!, addedMs);
      await applyPublication(
        tx,
        roomId,
        item.payload.stay,
        change.pos,
        item.publication,
        localServers,
      );
      return;
    }
    case 'history': {
      // History is never news: indexed without a seq, never a feed row.
      // The upsert promotes a held evidence row to grounded (first-owner).
      await tx.execute(
        `INSERT INTO event_index(event, room, pos, standing, grounding, reason, rule, origin, seq)
         VALUES(?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(event) DO UPDATE SET
           standing = excluded.standing, grounding = excluded.grounding,
           reason = excluded.reason, rule = excluded.rule,
           origin = excluded.origin
         WHERE ${
          changedColumns(
            'event_index',
            'standing',
            'grounding',
            'reason',
            'rule',
            'origin',
          )
        }`,
        [
          change.event,
          roomId,
          change.pos,
          item.payload.standing,
          item.payload.grounding,
          item.payload.reason,
          item.payload.rule,
          item.payload.origin,
        ],
      );
      await applyRelation(tx, roomId, item);
      await applyReceiptGraph(tx, roomId, item);
      await reconcileNotificationEvent(tx, roomId, change.event!, addedMs);
      return;
    }
    case 'membership': {
      if (item.to === null) {
        // no member event in the published state — the same 'leave' the
        // reads default to without a row (MSC4115)
        await tx.execute(
          'DELETE FROM memberships WHERE user = ? AND room = ?',
          [item.user, roomId],
        );
        await queueBadge(tx, item.user);
        return;
      }
      // The old fold's own-event seq, else the triggering seq: the member
      // event's own feed position when it has one (a live event), else the
      // trigger's. (change.event is guaranteed — prepare rejects a
      // membership change without it.)
      const eventId = item.toId ?? change.event!;
      const seq = (await seqOf(tx, roomId, eventId)) ??
        (await feedSeqOf(tx, roomId, change.event!));
      await applyMember(
        tx,
        roomId,
        item.user,
        item.to,
        eventId,
        seq,
        localServers,
      );
      return;
    }
    case 'redaction': {
      // the applied effect (the old redacted_by, last writer wins)
      await tx.execute(
        `INSERT INTO redactions(target, room, event, pos)
         VALUES(?,?,?,?)
         ON CONFLICT(target) DO UPDATE SET
           event = excluded.event, pos = excluded.pos`,
        [item.target, roomId, change.event, change.pos],
      );
      await reconcileNotificationEvent(tx, roomId, item.target, addedMs);
      if (
        (await tx.query(
          'SELECT 1 FROM e2ee_rooms WHERE room=? AND encryption_event=? AND encrypted=1',
          [roomId, item.target],
        )).length
      ) {
        const members =
          (await tx.query('SELECT user FROM e2ee_room_members WHERE room=?', [
            roomId,
          ])).map((r) => String(r.user));
        await reconcileDeviceRoom(
          tx,
          roomId,
          members,
          false,
          item.target,
          change.pos,
          localServers,
        );
      }
      return;
    }
    case 'delivery': {
      for (const destination of item.destinations) {
        await tx.execute(
          `INSERT INTO outbox(room, pos, destination, event, state, attempts, next_attempt_ms, added_ms)
           VALUES(?,?,?,?,'pending',0,0,?) ON CONFLICT DO NOTHING`,
          [roomId, change.pos, destination, change.event, addedMs],
        );
      }
      return;
    }
  }
}

async function applyReceiptGraph(
  tx: Conn,
  roomId: string,
  item: Extract<Prepared, { payload: EventPayload }>,
): Promise<void> {
  if (item.prevs === null) return;
  await projectReceiptGraph(
    tx,
    roomId,
    item.change.event!,
    item.prevs,
    item.receiptMembership,
  );
}

// Reconcile against what the server has actually projected, in the same
// transaction as the live feed cut. This also sees earlier batch writes.
// Imported opening changes take the new stay's first live seq; ordinary
// publication changes retain the existing own-event/trigger seq contract.
async function applyPublication(
  tx: Conn,
  roomId: string,
  stay: number | null,
  pos: number,
  publication: Publication | null,
  localServers: string[],
): Promise<void> {
  if (publication === null || stay === null) return;
  const members = publication.members;
  const current = new Map((await tx.query(
    'SELECT user, membership, event FROM memberships WHERE room = ?',
    [roomId],
  )).map((row) => [String(row.user), row]));
  const target = new Set(members.map((m) => m.user));
  for (const user of current.keys()) {
    if (!target.has(user)) {
      await tx.execute(
        'DELETE FROM memberships WHERE user = ? AND room = ?',
        [user, roomId],
      );
      await queueBadge(tx, user);
    }
  }
  const cut = await feedSeqAtPos(tx, roomId, pos);
  if (cut === null) {
    throw new Error(`publication at pos ${pos} without a feed row`);
  }
  const first = (await tx.query(
    'SELECT 1 FROM feed WHERE room = ? AND stay = ? AND pos < ? LIMIT 1',
    [roomId, stay, pos],
  )).length === 0;
  for (const member of members) {
    const prior = current.get(member.user);
    if (prior?.event === member.toId && prior.membership === member.to) {
      continue;
    }
    const seq = first ? cut : (await seqOf(tx, roomId, member.toId)) ?? cut;
    await applyMember(
      tx,
      roomId,
      member.user,
      member.to,
      member.toId,
      seq,
      localServers,
    );
  }
  await applyDevicePublication(tx, roomId, publication, pos, localServers);
}

async function applyDevicePublication(
  tx: Conn,
  roomId: string,
  publication: Publication,
  pos: number,
  localServers: string[],
): Promise<void> {
  const redacted = publication.encryption !== null &&
    (await tx.query('SELECT 1 FROM redactions WHERE target=?', [
        publication.encryption,
      ])).length > 0;
  await reconcileDeviceRoom(
    tx,
    roomId,
    publication.members.filter((m) => m.to === 'join').map((m) => m.user),
    publication.encrypted && !redacted,
    publication.encryption,
    pos,
    localServers,
  );
}

// Both the full-publication and explicit membership-change paths preserve
// an unchanged row's seq, including the redundant change after a join cut.
async function applyMember(
  tx: Conn,
  roomId: string,
  user: string,
  membership: string,
  eventId: string,
  seq: number | null,
  localServers: string[],
): Promise<void> {
  const changed = await tx.execute(
    `INSERT INTO memberships(user, room, membership, event, seq)
     VALUES(?,?,?,?,?)
     ON CONFLICT(user, room) DO UPDATE SET
       membership = excluded.membership, event = excluded.event, seq = excluded.seq
     WHERE memberships.event != excluded.event OR memberships.membership != excluded.membership`,
    [user, roomId, membership, eventId, seq],
  );
  if (changed) await queueBadge(tx, user);
  // Participation protects the room even when a concurrent forget still hides
  // it from this user. Only retained local admission can remove that intent.
  if (membership === 'join' && localServers.includes(domainOf(user))) {
    await tx.execute('UPDATE directory SET purgeable_ms=NULL WHERE room_id=?', [
      roomId,
    ]);
  }
}

async function feedSeqAtPos(
  tx: Conn,
  roomId: string,
  pos: number,
): Promise<number | null> {
  const rows = await tx.query(
    'SELECT seq FROM feed WHERE room = ? AND pos = ?',
    [roomId, pos],
  );
  if (rows.length === 0) return null;
  return Number(rows[0].seq);
}

// The feed write shared by 'event' and 'transition': the row is idempotent
// on (room, pos); the seq auto-assigns in projection order and mirrors back
// into event_index (deterministic on replay). Relations and search take
// the event's own seq, exactly the old "seq IS NOT NULL" rule.
async function applyLive(
  tx: Conn,
  roomId: string,
  item: Prepared & { kind: 'event' | 'transition' | 'history' },
  addedMs: number,
): Promise<void> {
  const existing = await feedSeqAtPos(tx, roomId, item.change.pos);
  const seq = existing ?? await nextEventSeq(tx);
  if (existing === null) {
    await tx.execute(
      'INSERT INTO feed(seq, room, pos, event, stay) VALUES(?,?,?,?,?)',
      [seq, roomId, item.change.pos, item.change.event, item.payload.stay],
    );
  }
  await tx.execute(
    'UPDATE event_index SET seq=? WHERE event=? AND seq IS NOT ?',
    [seq, item.change.event, seq],
  );
  await applyRelation(tx, roomId, item);
  await reconcileNotificationEvent(tx, roomId, item.change.event!, addedMs);
  if (item.search !== null) {
    await tx.execute(
      `INSERT INTO search(event, room, seq, key, sender, origin_ts, body_lower)
       VALUES(?,?,(SELECT seq FROM feed WHERE room = ? AND event = ?),?,?,?,?)
       ON CONFLICT(event) DO NOTHING`,
      [
        item.change.event,
        roomId,
        roomId,
        item.change.event,
        item.search.key,
        item.payload.sender,
        item.payload.origin_server_ts,
        item.search.text,
      ],
    );
  }
  if (existing === null && item.push !== null) {
    await applyPushPublication(
      tx,
      roomId,
      item.change.event!,
      seq,
      item.change.pos,
      item.push,
      addedMs,
    );
  }
}

async function applyRelation(
  tx: Conn,
  roomId: string,
  item: Prepared & { kind: 'event' | 'transition' | 'history' },
): Promise<void> {
  if (item.relation !== null) {
    await tx.execute(
      `INSERT INTO relations(event, relates_to, rel_type, room, seq)
       VALUES(?,?,?,?,(SELECT seq FROM feed WHERE room = ? AND event = ?))
        ON CONFLICT(event) DO UPDATE SET seq=excluded.seq
        WHERE relations.seq IS NULL AND excluded.seq IS NOT NULL`,
      [
        item.change.event,
        item.relation.relatesTo,
        item.relation.relType,
        roomId,
        roomId,
        item.change.event,
      ],
    );
  }
}

async function seqOf(
  tx: Conn,
  roomId: string,
  event: string,
): Promise<number | null> {
  const rows = await tx.query(
    'SELECT seq FROM event_index WHERE room = ? AND event = ?',
    [roomId, event],
  );
  if (rows.length === 0 || rows[0].seq === null) return null;
  return Number(rows[0].seq);
}

async function feedSeqOf(
  tx: Conn,
  roomId: string,
  event: string,
): Promise<number | null> {
  const rows = await tx.query(
    'SELECT seq FROM feed WHERE room = ? AND event = ?',
    [roomId, event],
  );
  if (rows.length === 0) return null;
  return Number(rows[0].seq);
}
