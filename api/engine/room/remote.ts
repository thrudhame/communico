// api/engine/room/remote.ts — remote PDU ingest (3c-1): the room core's
// path for PDUs received from other servers. Per batch (the PDUs of one
// room from one transaction): verify each through the ONE verification
// path (verify.ts, G9/G10) and return known-event receipts without
// re-verification (I2); gather what is missing — the wait
// (missingwaitms), ONE get_missing_events (missinglimit), then
// /state_ids + /event only for gap tips behind pulled events and
// /event_auth for missing declared auth events, all inside the
// whole-batch budget (missingbudgetms) and NEVER under the lock (R13);
// then one room transaction under the per-room lock: revalidated
// lifecycle (G8 — the fetch phase may be stale), evidence stored after
// its own auth check (R2 — bytes, never state-at-event), and every
// event in depth/topology order through the shared locked pipeline
// (auth events, state before, current state → soft-fail per spec), one
// transaction for the whole batch (G11). What stays ungrounded after
// the budget lands pending + waits (R10); a later arrival re-runs it
// (resumeWaits in ingest.ts).
import { canonicalJson } from '#engine/canonical.ts';
import { createHash } from 'node:crypto';
import { eventIdFor } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { StateMap } from '#engine/rulebook/index.ts';
import {
  authorizedBoundary,
  checkDeclaredAuth,
  loadRulebookStore,
  roomCreateId,
  roomVersionOf,
  ungroundedPrevs,
} from '#engine/room/build.ts';
import { fetchOrNull, type RemoteDeps } from '#engine/room/deps.ts';
import {
  admitLocalJoin,
  prepareMembershipAdmission,
  withMembershipFence,
} from '#engine/room/hooks.ts';
import { assertLocalEncryption } from '#engine/room/encryption-policy.ts';
import { afterRoomCommit, ingestInTx } from '#engine/room/ingest.ts';
import type { Room, RoomTx } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { aclAllows, assertAcl } from '#engine/room/acl.ts';
import { orderEvents } from '#engine/room/order.ts';
import { stageRecoveryEvidence } from '#engine/room/recovery.ts';
import { fetchBoundaryEvents } from '#engine/room/boundary-fetch.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { identify, verify } from '#engine/room/verify.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';
import {
  RecoveryAncestry,
  type RecoverySnapshot,
} from '#engine/room/recovery-ancestry.ts';
import { setTimeout as delay } from 'node:timers/promises';

export type RemoteOutcomeKind =
  | 'accepted'
  | 'rejected'
  | 'soft_failed'
  | 'pending'
  | 'known'
  | 'dropped'
  | 'refused';

// One entry per input PDU, in input order. Fetched events are internal —
// they get no outcome.
export type RemoteOutcome = {
  eventId: string | null; // null when uncomputable (no result entry)
  outcome: RemoteOutcomeKind;
  reason: 'auth' | 'state' | null;
  rule: string | null;
  error: string | null;
};

function outcomeOf(
  eventId: string | null,
  outcome: RemoteOutcomeKind,
  error: string | null = null,
): RemoteOutcome {
  return { eventId, outcome, reason: null, rule: null, error };
}

type VerifiedItem = {
  index: number; // position in the input; -1 for fetched events
  source: 'pushed' | 'pulled';
  pdu: Pdu;
  eventId: string;
  oversized: boolean;
};

// Everything the unlocked fetch phase gathers for the locked batch.
type FetchAcc = {
  // Verified supplied identities survive later auth/ingest rejection. Bytes
  // being invalid does not mean the peer withheld a pushed event's parent.
  supplied: Set<string>;
  // Verified events to ingest live: pushed PDUs and fetched missing
  // events alike, keyed by id.
  live: Map<string, VerifiedItem>;
  // Verified fetched events stored with grounding evidence (R2) after
  // their own auth check under the lock.
  evidence: Map<string, Pdu>;
  // Gap tips whose auth chain could not be fetched (…CorruptedAuthChain):
  // stored rejected as evidence, grounding nothing (requirements §4.2 R5).
  corrupted: Map<string, Pdu>;
  // Gap tip → the imported before-state boundary (R5, G1).
  boundaries: Map<string, StateMap>;
  // Pushed events whose direct parents stayed unavailable after missing-events.
  // Distinct from a supplied pulled parent's later auth/state failure.
  unavailablePrevs: Set<string>;
  // Verify-failed ids in this chain: terminal, no /state_ids fallthrough
  // (the BadJSON case).
  terminal: Set<string>;
};

// Held bytes with no genuine after-state (pending or evidence) are not
// grounding (G2); only grounded events have DAG state refs.
async function groundingOf(
  room: Room,
  id: string,
): Promise<'grounded' | 'held' | 'unknown'> {
  return await room.tx(async (tx) => {
    const row = await tx.events.get(id);
    if (row === null) return 'unknown';
    const after = await tx.state.eventStateAfter(id);
    return after === null ? 'held' : 'grounded';
  });
}

// Supply is a batch-wide fact, separate from whether supplied bytes can ground.
// Use the same complete-parent admission at every pushed traversal entry and
// when rendering final receipts after all missing-events replies have arrived.
async function parentsSupplied(
  room: Room,
  ids: readonly string[],
  acc: FetchAcc,
  signal?: AbortSignal,
): Promise<boolean> {
  return await room.tx(async (tx) => {
    signal?.throwIfAborted();
    for (const id of ids) {
      signal?.throwIfAborted();
      if (
        !acc.supplied.has(id) &&
        (await tx.state.eventStateAfter(id)) === null
      ) return false;
    }
    return true;
  });
}

// A fallback is conditional on the batch's knowledge of its ungrounded prev
// graph. Later inputs can discover corruption behind an earlier boundary. Walk
// the shared final graph at reuse and locked admission, stopping only at genuine
// persisted after-state, never at another cached fallback.
async function invalidRecoveryAncestry(
  tx: RoomTx,
  ids: readonly string[],
  acc: FetchAcc,
  signal?: AbortSignal,
): Promise<boolean> {
  const pending = [...ids];
  const seen = new Set<string>();
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if ((await tx.state.eventStateAfter(id)) !== null) continue;
    signal?.throwIfAborted();
    if (acc.corrupted.has(id) || acc.terminal.has(id)) return true;
    const pdu = acc.live.get(id)?.pdu ?? acc.evidence.get(id);
    pending.push(...(pdu?.prev_events ?? await tx.events.prevsOf(id)));
  }
  return false;
}

// Collect the brief wait and ONE missing-events response per input, with the
// room lock RELEASED. Pushed batches complete this verified union before any
// ancestry recovery, so later replies cannot leave earlier inputs deferred.
async function fetchMissing(
  room: Room,
  item: VerifiedItem,
  origin: string,
  deps: RemoteDeps,
  version: string,
  budget: { until: number },
  acc: FetchAcc,
): Promise<void> {
  deps.signal?.throwIfAborted();
  // Direct-parent supply and ancestry grounding are different questions. A
  // verified supplied parent needs no repeated brief wait/get_missing_events
  // through its own held prefix. The batch recovery owner handles that prefix.
  const missingNow = async (): Promise<string[]> =>
    await room.tx(async (tx) => {
      deps.signal?.throwIfAborted();
      const missing: string[] = [];
      for (const id of new Set(item.pdu.prev_events ?? [])) {
        if (
          !acc.live.has(id) && !acc.boundaries.has(id) &&
          (await tx.state.eventStateAfter(id)) === null
        ) missing.push(id);
      }
      return missing;
    });
  const budgetLeft = () => budget.until - Date.now();
  let missing = await missingNow();

  // 1. WAIT missingwaitms, waking early when the prevs arrive (the
  //    sender usually pushes them next) — the lock is NOT held meanwhile
  {
    const deadline = Date.now() +
      Math.min(deps.limits.waitMs, Math.max(0, budgetLeft()));
    while (missing.length > 0 && Date.now() < deadline) {
      await delay(25, undefined, { signal: deps.signal });
      missing = await missingNow();
    }
  }

  // 2. ONE get_missing_events (backfill.yaml:71-141): earliest = our
  //    current forward extremities, latest = the pushed PDU, limit =
  //    missinglimit. Verified answers land live; a verify failure is a
  //    drop and terminal for its cited id in this chain (…BadJSON).
  if (missing.length > 0 && budgetLeft() > 0) {
    const earliest = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      return stay === null ? [] : await tx.extremities.frontier(stay.id);
    });
    let answered: Pdu[] = [];
    try {
      answered = await deps.fetcher.missingEvents(
        room.id,
        earliest,
        [item.eventId],
        deps.limits.limit,
        origin,
        deps.signal,
      );
    } catch (error) {
      deps.signal?.throwIfAborted();
      if (!recoverableUpstream(error)) throw error;
      // the fetch failed outright — fall through to the chase
    }
    let dropped = 0;
    for (const raw of answered) {
      deps.signal?.throwIfAborted();
      try {
        const v = await verify(raw, version, deps.keys, {
          roomId: room.id,
          signal: deps.signal,
        });
        acc.supplied.add(v.eventId);
        if (!acc.live.has(v.eventId)) {
          acc.live.set(v.eventId, {
            index: -1,
            source: 'pulled',
            pdu: v.pdu,
            eventId: v.eventId,
            oversized: v.oversized,
          });
        }
      } catch (error) {
        if (!recoverableUpstream(error)) throw error;
        dropped++;
      }
    }
    // a dropped answer can leave the pushed PDU's prev dangling under the
    // CITED id (authored under different redaction rules, our computed id
    // differs from the citation): tombstone the cited prev in this chain
    // or the chase asks /state_ids for it forever (…BadJSONForRoomVersion6)
    if (dropped > 0 && missing.length === 1 && !acc.live.has(missing[0])) {
      acc.terminal.add(missing[0]);
    }
  }
}

// Chase the final supplied union, inside the original whole-batch budget.
// Only pulled events permit state recovery behind their unresolved parents.
function recoveryOwner(
  room: Room,
  origin: string,
  deps: RemoteDeps,
  version: string,
  budget: { until: number },
  acc: FetchAcc,
): (item: VerifiedItem) => Promise<void> {
  const budgetLeft = () => budget.until - Date.now();
  // 3. Prefer the deeper DAG connection, but retain each pulled event as a
  // possible imported boundary if older ancestry is unavailable. Held bytes
  // alone do not ground anything; only genuine after-state or a complete
  // fetched boundary can make a branch recoverable. Locked ingest still
  // authorizes every boundary and event before publishing any state.
  type Recovery = 'ready' | 'unavailable' | 'invalid';
  const attempted = new Set<string>();
  const recovered = new Map<string, Recovery>();
  const visiting = new Set<string>();
  const ancestry = new RecoveryAncestry(room, () => {
    deps.signal?.throwIfAborted();
    return budgetLeft() > 0;
  });
  let snapshot: RecoverySnapshot | null = null;
  const refresh = async () => {
    const next = await ancestry.snapshot(
      acc.live,
      acc.boundaries,
      acc.terminal,
    );
    if (next !== snapshot) recovered.clear();
    snapshot = next;
  };
  const fetchBoundary = async (id: string): Promise<Recovery> => {
    deps.signal?.throwIfAborted();
    // missinglimit sizes the missing-events answer, not this state-recovery
    // ladder. Charging older misses against it can suppress every usable
    // pulled boundary. All attempts retain the original whole-batch budget.
    if (acc.corrupted.has(id)) return 'invalid';
    if (budgetLeft() <= 0 || attempted.has(id)) return 'unavailable';
    attempted.add(id);
    await fetchGapTip(room, id, origin, deps, version, budget, acc);
    // A network wait may have admitted local parents or changed the supplied
    // union/boundaries. No missing/readiness result survives that changed cut.
    await refresh();
    return acc.boundaries.has(id)
      ? 'ready'
      : acc.corrupted.has(id)
      ? 'invalid'
      : 'unavailable';
  };
  const chase = async (
    id: string,
    source: VerifiedItem['source'],
  ): Promise<Recovery> => {
    type Walk = {
      view: RecoverySnapshot;
      key: string;
      provenance: VerifiedItem['source'];
      prevs: string[];
      next: number;
      result: Recovery;
    };
    type Frame = { id: string; source: VerifiedItem['source']; walk?: Walk };
    // Captured held paths may have no I/O before their deepest ancestor.
    // Heap-owned DFS frames, including snapshot retries, never grow the JS stack.
    const stack: Frame[] = [{ id, source }];
    let result: Recovery = 'unavailable';
    const finish = (verdict: Recovery) => {
      stack.pop();
      const parent = stack.at(-1)?.walk;
      if (parent !== undefined) {
        if (verdict === 'invalid') parent.result = 'invalid';
        else if (verdict === 'unavailable' && parent.result === 'ready') {
          parent.result = 'unavailable';
        }
      }
      result = verdict;
    };
    try {
      while (stack.length > 0) {
        deps.signal?.throwIfAborted();
        const frame = stack.at(-1)!;
        const { id, source } = frame;
        if (frame.walk === undefined) {
          if (acc.boundaries.has(id)) {
            finish(
              await room.tx((tx) =>
                  invalidRecoveryAncestry(tx, [id], acc, deps.signal)
                )
                ? 'invalid'
                : 'ready',
            );
            continue;
          }
          if (
            acc.terminal.has(id) || acc.corrupted.has(id) || visiting.has(id)
          ) {
            finish('invalid');
            continue;
          }
          if (budgetLeft() <= 0 || snapshot === null) {
            finish('unavailable');
            continue;
          }
          const view = snapshot;
          const key = JSON.stringify([id, source]);
          const prior = recovered.get(key);
          if (prior !== undefined) {
            finish(prior);
            continue;
          }
          const held = view.nodes.get(id);
          if (held?.grounded) {
            finish('ready');
            continue;
          }
          const answered = acc.live.get(id);
          if (answered === undefined && source === 'pushed') {
            finish('unavailable');
            continue;
          }
          if (answered === undefined && held === undefined) {
            const ready = await fetchBoundary(id);
            if (snapshot !== view) continue;
            recovered.set(key, ready);
            finish(ready);
            continue;
          }
          // Pushed provenance wins and requires the complete direct parent set;
          // it may never import state to bypass withheld parents.
          const provenance = answered?.source ?? source;
          const prevs = answered?.pdu.prev_events ?? held?.prevs ?? [];
          if (
            provenance === 'pushed' &&
            prevs.some((prev) =>
              !acc.supplied.has(prev) && !view.nodes.get(prev)?.grounded
            )
          ) {
            finish('unavailable');
            continue;
          }
          visiting.add(id);
          frame.walk = {
            view,
            key,
            provenance,
            prevs,
            next: 0,
            result: 'ready',
          };
        }
        const walk = frame.walk;
        if (walk.next < walk.prevs.length) {
          stack.push({ id: walk.prevs[walk.next++], source: walk.provenance });
          continue;
        }
        if (walk.result === 'unavailable' && walk.provenance === 'pulled') {
          walk.result = await fetchBoundary(id);
        }
        visiting.delete(id);
        if (snapshot !== walk.view) {
          frame.walk = undefined;
          continue;
        }
        recovered.set(walk.key, walk.result);
        finish(walk.result);
      }
      return result;
    } finally {
      for (const frame of stack) {
        if (frame.walk !== undefined) visiting.delete(frame.id);
      }
    }
  };
  return async (item) => {
    await refresh();
    await chase(item.eventId, item.source);

    // 4. missing DECLARED AUTH events of everything we are about to ingest
    //    (this PDU plus what the answer landed) — one /event_auth per
    //    event, inside the budget
    if (budgetLeft() > 0) {
      const want = [item, ...(acc.live.values().filter((v) => v.index === -1))];
      for (const target of want) {
        deps.signal?.throwIfAborted();
        const declared = target.pdu.auth_events ?? [];
        if (declared.length === 0) continue;
        const missingAuth: string[] = [];
        for (const id of declared) {
          deps.signal?.throwIfAborted();
          if (acc.evidence.has(id) || acc.live.has(id)) continue;
          if ((await groundingOf(room, id)) === 'unknown') missingAuth.push(id);
        }
        if (missingAuth.length === 0) continue;
        if (budgetLeft() <= 0) return;
        const chain = await fetchOrNull(() =>
          deps.fetcher.eventAuth(
            room.id,
            target.eventId,
            origin,
            deps.signal,
          ), deps.signal);
        deps.signal?.throwIfAborted();
        if (chain === null) continue;
        // missinglimit bounds get_missing_events, not this required auth
        // pack. A prefix is not an auth chain. Verify the whole answer
        // within the batch budget before exposing any of it to ingest.
        const sorted = [...chain].sort((a, b) => a.depth - b.depth);
        const verified = new Map<string, Pdu>();
        for (const raw of sorted) {
          deps.signal?.throwIfAborted();
          if (budgetLeft() <= 0) return;
          try {
            const v = await verify(raw, version, deps.keys, {
              roomId: room.id,
              signal: deps.signal,
            });
            if (!acc.live.has(v.eventId)) verified.set(v.eventId, v.pdu);
          } catch (error) {
            if (!recoverableUpstream(error)) throw error;
            // an unverifiable auth-chain event is simply not evidence
          }
        }
        if (budgetLeft() <= 0) return;
        for (const [id, pdu] of verified) acc.evidence.set(id, pdu);
      }
    }
  };
}

// /state_ids + /event for one gap tip: the fetched state is the tip's
// imported before-state (G1); the fetched state/auth events are evidence
// candidates; an unfetchable auth chain makes the tip a standing
// rejected record that grounds nothing (…CorruptedAuthChain).
async function fetchGapTip(
  room: Room,
  tip: string,
  origin: string,
  deps: RemoteDeps,
  version: string,
  budget: { until: number },
  acc: FetchAcc,
): Promise<void> {
  deps.signal?.throwIfAborted();
  const ids = await fetchOrNull(
    () => deps.fetcher.stateIds(room.id, tip, origin, deps.signal),
    deps.signal,
  );
  deps.signal?.throwIfAborted();
  if (ids === null) return;
  const authSet = new Set(ids.authChainIds);
  const wanted = [...new Set([...ids.pduIds, ...ids.authChainIds])].sort();
  const unknown = await room.tx(async (tx) => {
    deps.signal?.throwIfAborted();
    const held = await tx.events.list(wanted);
    return wanted.filter((id) => !held.has(id));
  });
  // A state/auth boundary must not lose dependencies to the unrelated
  // get_missing_events batch size. The whole-batch time budget still
  // bounds fetching; an unfinished pack supplies no imported state.
  const pack = await fetchBoundaryEvents(unknown, wanted.length, {
    roomId: room.id,
    at: tip,
    via: origin,
    version,
    fetcher: deps.fetcher,
    keys: deps.keys,
    signal: deps.signal,
    concurrency: 8,
    active: () => {
      deps.signal?.throwIfAborted();
      return budget.until > Date.now();
    },
    read: (op) => fetchOrNull(op, deps.signal),
  });
  deps.signal?.throwIfAborted();
  if (pack === null) return;
  const corruptedAuth = unknown.some((id) => authSet.has(id) && !pack.has(id));
  // A verified pulled tip already supplied by missing-events (or the pulled
  // input) needs no second network copy. Keep its provenance and input index.
  let tipPdu: Pdu | null = null;
  const supplied = acc.live.get(tip);
  const rawTip = supplied?.source === 'pulled'
    ? supplied.pdu
    : await fetchOrNull(
      () => deps.fetcher.event(tip, origin, room.id, deps.signal),
      deps.signal,
    );
  deps.signal?.throwIfAborted();
  if (rawTip !== null) {
    try {
      const v = await verify(rawTip, version, deps.keys, {
        roomId: room.id,
        signal: deps.signal,
      });
      if (v.eventId === tip) {
        acc.supplied.add(tip);
        tipPdu = v.pdu;
        if (supplied === undefined) {
          acc.live.set(tip, {
            index: -1,
            source: 'pulled',
            pdu: v.pdu,
            eventId: tip,
            oversized: v.oversized,
          });
        }
      }
    } catch (error) {
      if (!recoverableUpstream(error)) throw error;
      // stays missing — the caller's terminal decides
    }
  }
  if (tipPdu === null || budget.until - Date.now() <= 0) return;
  if (corruptedAuth) {
    acc.live.delete(tip);
    acc.corrupted.set(tip, tipPdu);
    return;
  }
  // the imported boundary: the remote's state at the event, from the
  // state ids we can read (held events and the just-fetched pack)
  const boundary: StateMap = new Map();
  for (const id of ids.pduIds) {
    deps.signal?.throwIfAborted();
    const pdu = pack.get(id) ??
      await room.tx(async (tx) => {
        const row = await tx.events.get(id);
        return row === null ? null : (JSON.parse(row.pdu) as Pdu);
      });
    if (pdu === null || pdu.state_key === undefined) return;
    boundary.set(String(pdu.type) + '\0' + String(pdu.state_key), id);
  }
  for (const [id, pdu] of pack) {
    if (!acc.live.has(id)) acc.evidence.set(id, pdu);
  }
  acc.boundaries.set(tip, boundary);
}

// Ingest a batch of PDUs received from `origin` for one room. Per-PDU
// outcomes in input order; room-level failures (unknown room, archived
// stay) throw. One room transaction for the whole batch (G11).
// The only pulled-input caller is the verified resident send_join response;
// transaction receipt uses the default pushed source.
function batchInputHash(
  room: Room,
  pdus: Pdu[],
  origin: string,
  source: VerifiedItem['source'],
) {
  return createHash('sha256')
    .update(canonicalJson({
      room: room.id,
      origin,
      pdus: pdus.map((pdu) => {
        const retained = { ...pdu };
        delete retained.unsigned;
        return retained;
      }),
      source,
    }))
    .digest('hex');
}

/** Recall before a transport's participation guard. A room may have archived
 * after committing the batch but before its caller saved the child result. */
export async function replayRemoteBatch(
  room: Room,
  pdus: Pdu[],
  origin: string,
  self: string,
  operationId: string,
  source: VerifiedItem['source'] = 'pushed',
  signal?: AbortSignal,
): Promise<RemoteOutcome[] | null> {
  if (!operationId) throw new Error('E_REMOTE_BATCH_IDENTITY');
  const prior = await room.tx((tx) =>
    tx.remoteBatches.get(
      operationId,
      batchInputHash(room, pdus, origin, source),
    )
  );
  if (prior) {
    await afterRoomCommit(
      room,
      self,
      prior.flatMap((outcome) =>
        outcome.eventId === null ? [] : [outcome.eventId]
      ),
      signal,
    );
  }
  return prior;
}

export async function ingestRemote(
  room: Room,
  pdus: Pdu[],
  origin: string,
  deps: RemoteDeps,
  source: VerifiedItem['source'] = 'pushed',
  operationId?: string,
): Promise<RemoteOutcome[]> {
  deps.signal?.throwIfAborted();
  const inputHash = operationId === undefined
    ? ''
    : batchInputHash(room, pdus, origin, source);
  if (operationId !== undefined) {
    const prior = await replayRemoteBatch(
      room,
      pdus,
      origin,
      deps.self,
      operationId,
      source,
      deps.signal,
    );
    if (prior) return prior;
  }
  const admission = deps.localJoin === undefined
    ? undefined
    : await prepareMembershipAdmission(
      room.store,
      room.id,
      deps.localJoin.userId,
      true,
    );
  const version = await room.tx(async (tx) => {
    deps.signal?.throwIfAborted();
    const stay = await tx.segments.openStay();
    if (stay === null) {
      throw new Error('E_ROOM_ARCHIVED: no open stay for ' + room.id);
    }
    return await roomVersionOf(tx, stay.id);
  });
  const outcomes: (RemoteOutcome | null)[] = pdus.map(() => null);

  // Denied traffic must not trigger key discovery or missing-event fetches.
  if (!await room.tx((tx) => aclAllows(tx, origin))) {
    const denied = await Promise.all(pdus.map(async (pdu) => {
      let id: string | null = null;
      try {
        id = await eventIdFor(
          pdu as unknown as Record<string, unknown>,
          version,
        );
      } catch { /* uncomputable */ }
      return outcomeOf(id, 'refused', 'server denied by room ACL');
    }));
    return operationId === undefined
      ? denied
      : await room.tx((tx) =>
        tx.remoteBatches.save(operationId, inputHash, denied)
      );
  }

  // identify every PDU (format guards, unsigned strip, recomputed id) —
  // a failure is refused before storage
  const identified: { index: number; pdu: Pdu; eventId: string }[] = [];
  for (const [index, pdu] of pdus.entries()) {
    deps.signal?.throwIfAborted();
    try {
      const pre = await identify(pdu, version, { roomId: room.id });
      identified.push({ index, pdu, eventId: pre.eventId });
    } catch (e) {
      if (!recoverableUpstream(e)) throw e;
      let eventId: string | null = null;
      try {
        eventId = await eventIdFor(
          pdu as unknown as Record<string, unknown>,
          version,
        );
      } catch {
        // uncomputable — no result entry
      }
      outcomes[index] = outcomeOf(eventId, 'refused', String(e));
    }
  }

  // Idempotent redelivery (I2): a known GROUNDED event returns its
  // receipt without re-verification; a pending one falls through (ruling
  // B)
  const knownStatuses = await room.tx(async (tx) =>
    await tx.events.statuses(identified.map((item) => item.eventId))
  );
  const items: VerifiedItem[] = [];
  for (const item of identified) {
    deps.signal?.throwIfAborted();
    const status = knownStatuses.get(item.eventId);
    if (status !== undefined && status.grounding !== 'pending') {
      outcomes[item.index] = outcomeOf(item.eventId, 'known');
      continue;
    }
    try {
      const v = await verify(item.pdu, version, deps.keys, {
        roomId: room.id,
        signal: deps.signal,
      });
      items.push({
        index: item.index,
        source,
        pdu: v.pdu,
        eventId: v.eventId,
        oversized: v.oversized,
      });
    } catch (e) {
      if (!recoverableUpstream(e)) throw e;
      outcomes[item.index] = outcomeOf(item.eventId, 'refused', String(e));
    }
  }

  // The unlocked fetch phase: gather what is missing before the lock,
  // inside the whole-batch budget (R13 — network never under the lock)
  const acc: FetchAcc = {
    supplied: new Set(items.map((item) => item.eventId)),
    live: new Map(items.map((item) => [item.eventId, item])),
    evidence: new Map(),
    corrupted: new Map(),
    boundaries: new Map(),
    unavailablePrevs: new Set(),
    terminal: new Set(),
  };
  const budget = { until: Date.now() + deps.limits.budgetMs };
  const recoverMissing = recoveryOwner(
    room,
    origin,
    deps,
    version,
    budget,
    acc,
  );
  if (source === 'pushed') {
    for (const item of items) {
      await fetchMissing(room, item, origin, deps, version, budget, acc);
    }
  }
  for (const item of items) {
    // Pulled inputs have no parent-disclosure gate. Preserve their existing
    // incremental recovery, including not refetching gaps already recovered by
    // an earlier pulled input; only pushed admission needs every reply first.
    if (source === 'pulled') {
      await fetchMissing(room, item, origin, deps, version, budget, acc);
    }
    await recoverMissing(item);
  }
  // A later input's missing-events answer can supply an earlier input's parent.
  // Decide unavailability once from the final verified union, before subsequent
  // auth/state staging can discard supplied bytes that fail to ground.
  for (const item of items) {
    if (
      item.source === 'pushed' &&
      !await parentsSupplied(room, item.pdu.prev_events ?? [], acc, deps.signal)
    ) acc.unavailablePrevs.add(item.eventId);
  }

  // Evidence may commit in bounded pages before the live batch. Regardless of
  // cancellation or failure, every committed change retains its projection owner.
  let arrived: string[] = [];
  try {
    deps.signal?.throwIfAborted();
    if (
      !await stageRecoveryEvidence(
        room,
        acc.evidence,
        new Set(acc.live.keys()),
        origin,
        version,
        deps.signal,
      )
    ) {
      // Nothing fetched was accepted as live truth. Retain any staged outliers,
      // but no partial imported state: original inputs use normal pending/waits.
      acc.evidence.clear();
      acc.corrupted.clear();
      acc.boundaries.clear();
      acc.live = new Map(items.map((item) => [item.eventId, item]));
    }

    // One room transaction for the accepted batch, under the per-room lock
    const outcomeIndex = new Map<string, number[]>();
    for (const item of items) {
      const indexes = outcomeIndex.get(item.eventId) ?? [];
      indexes.push(item.index);
      outcomeIndex.set(item.eventId, indexes);
    }
    const committed = await withRoomLock(room.id, async () => {
      deps.signal?.throwIfAborted();
      if (deps.localJoin !== undefined) {
        await admitLocalJoin(
          room.store,
          room.id,
          deps.localJoin.userId,
          deps.localJoin.eventId,
        );
      }
      return await room.tx((tx) =>
        withMembershipFence(admission, tx, async () => {
          deps.signal?.throwIfAborted();
          if (operationId !== undefined) {
            const prior = await tx.remoteBatches.get(operationId, inputHash);
            if (prior) return { grounded: [], outcomes: prior };
          }
          const grounded: string[] = [];
          const results = new Map<number, RemoteOutcome>();
          // Revalidation (G8): the fetch phase ran unlocked — the stay, the
          // version and the extremities are re-read inside the lock
          const stay = await tx.segments.openStay();
          if (stay === null) {
            throw new Error('E_ROOM_ARCHIVED: no open stay for ' + room.id);
          }
          const lockedVersion = await roomVersionOf(tx, stay.id);
          const createId = await roomCreateId(tx, stay.id);
          const rulebook = getRulebook(lockedVersion);

          // The ingest set: pushed PDUs and fetched live events, deduplicated
          // (a pushed PDU wins over its fetched copy), in depth/topology
          // order — deterministic, so tests pin results
          const merged = new Map<string, VerifiedItem>();
          for (const [id, item] of acc.live) merged.set(id, item);
          for (const item of items) merged.set(item.eventId, item);

          // Evidence: verified fetched events, stored with grounding evidence
          // after their own auth check against their auth events (held +
          // pack); corrupted gap tips are standing rejected records. Neither
          // is ever state-at-event (G2), positioned or published.
          const pack = new Map<string, Pdu>([
            ...acc.evidence,
            ...acc.corrupted,
          ]);
          const candidates = new Map<string, VerifiedItem>();
          for (const [eventId, pdu] of pack) {
            candidates.set(eventId, {
              eventId,
              pdu,
              index: -1,
              source: 'pulled',
              oversized: false,
            });
          }
          for (const [id, item] of merged) candidates.set(id, item);
          const ordered = orderEvents([...candidates.values()], [
            'prev_events',
            'auth_events',
          ], (item) => [...(acc.boundaries.get(item.eventId)?.values() ?? [])]);
          const localRejected = new Set<string>(candidates.keys());
          const store = await loadRulebookStore(
            tx,
            [
              ...pack.keys(),
              ...[...pack.values()].flatMap((pdu) => pdu.auth_events ?? []),
              ...[...acc.boundaries.values()].flatMap((
                map,
              ) => [...map.values()]),
            ],
            [...candidates.values()].map((item) => item.pdu),
            localRejected,
          );
          for (const item of ordered) {
            deps.signal?.throwIfAborted();
            const { eventId: id, pdu } = item;
            // A preceding accepted ACL event in this batch changes admission now,
            // not on the next transaction. Refuse only this room's remaining PDUs.
            if (!await aclAllows(tx, origin)) {
              for (const index of outcomeIndex.get(id) ?? []) {
                results.set(
                  index,
                  outcomeOf(id, 'refused', 'server denied by room ACL'),
                );
              }
              continue;
            }
            localRejected.delete(id);
            const candidateBoundary = acc.boundaries.get(id);
            const boundary = candidateBoundary !== undefined &&
                !await invalidRecoveryAncestry(tx, [id], acc, deps.signal)
              ? candidateBoundary
              : undefined;
            const needsBoundary = boundary !== undefined &&
              (await ungroundedPrevs(tx, pdu.prev_events ?? [])).length > 0;
            const invalidBoundary = needsBoundary &&
              !authorizedBoundary(boundary, store, createId);
            if (!merged.has(id) || invalidBoundary) {
              if ((await tx.events.get(id)) !== null) continue; // first-writer
              const corrupted = acc.corrupted.has(id) || invalidBoundary;
              const chain = corrupted
                ? null
                : checkDeclaredAuth(pdu, rulebook, store, createId);
              const rejected = corrupted || chain === null || !chain.ok;
              if (rejected) localRejected.add(id);
              await tx.events.insert(
                id,
                pdu,
              );
              await tx.events.setStatus(id, {
                standing: rejected ? 'rejected' : 'accepted',
                grounding: 'evidence',
                origin,
                received_ts: Date.now(),
              });
              await tx.changes.append('event', id, {
                standing: rejected ? 'rejected' : 'accepted',
                reason: rejected && !corrupted ? 'auth' : null,
                rule: corrupted
                  ? 'unverifiable'
                  : chain !== null && !chain.ok
                  ? chain.rule
                  : null,
                type: String(pdu.type),
                state_key: pdu.state_key ?? null,
                sender: String(pdu.sender),
                depth: pdu.depth,
                origin_server_ts: pdu.origin_server_ts,
                stay: null,
                offset: null,
                grounding: 'evidence',
                origin,
              });
              if (!merged.has(id)) continue;
            }
            // Invalid imported state leaves the event as non-grounding evidence.
            // The normal receipt path reports its stored rejection; children
            // remain pending instead of inheriting that invalid state.
            if (id === deps.localJoin?.eventId) {
              if (
                pdu.sender !== deps.localJoin.userId ||
                pdu.state_key !== pdu.sender ||
                pdu.content?.membership !== 'join'
              ) {
                throw new Error('E_LOCAL_JOIN_IDENTITY');
              }
              await assertAcl(tx, deps.self);
              await assertLocalEncryption(
                tx,
                await tx.state.current(stay.id),
                pdu,
                deps.self,
              );
            }
            const res = await ingestInTx(tx, room.id, item.pdu, {
              remote: {
                origin,
                self: deps.self,
                oversized: item.oversized,
                ungroundedMs: deps.ungroundedMs,
                boundary: invalidBoundary ? undefined : boundary,
              },
            });
            if (res.standing === 'rejected') localRejected.add(id);
            if (res.grounding === 'grounded') grounded.push(item.eventId);
            const result = res.receipt
              ? outcomeOf(item.eventId, 'known')
              : !res.stored
              ? outcomeOf(item.eventId, 'dropped')
              : res.grounding === 'pending'
              ? outcomeOf(item.eventId, 'pending')
              : {
                eventId: item.eventId,
                outcome: res.standing,
                reason: res.reason,
                rule: res.rule,
                error: null,
              };
            if (
              res.grounding === 'pending' && acc.unavailablePrevs.has(id)
            ) {
              result.error =
                'Your server is not divulging the referenced prev_events';
            }
            for (const index of outcomeIndex.get(item.eventId) ?? []) {
              results.set(index, result);
            }
          }
          if (deps.localJoin !== undefined) {
            const { eventId, userId } = deps.localJoin;
            const status = await tx.events.getStatus(eventId);
            if (
              status?.standing === 'accepted' && status.grounding === 'grounded'
            ) {
              await tx.changes.localParticipation(eventId, userId);
              await tx.joinObservations.complete(
                eventId,
                deps.localJoin.observation,
              );
            }
          }
          const completed = outcomes.map((outcome, index) =>
            results.get(index) ?? outcome ??
              outcomeOf(null, 'refused', 'E_OUTCOME_MISSING')
          );
          deps.signal?.throwIfAborted();
          return {
            grounded,
            outcomes: operationId === undefined
              ? completed
              : await tx.remoteBatches.save(operationId, inputHash, completed),
          };
        })
      );
    });

    arrived = [
      ...identified.map((item) => item.eventId),
      ...acc.evidence.keys(),
      ...acc.corrupted.keys(),
      ...committed.grounded,
    ];
    return committed.outcomes;
  } finally {
    await afterRoomCommit(room, deps.self, arrived, deps.signal);
  }
}
