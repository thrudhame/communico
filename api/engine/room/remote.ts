// api/engine/room/remote.ts — remote PDU ingest (3c-1): the room core's
// path for PDUs received from other servers. Per batch (the PDUs of one
// room from one transaction): verify each through the ONE verification
// path (verify.ts, G9/G10) and return known-event receipts without
// re-verification (I2); gather what is missing — the wait
// (missingwaitms), ONE get_missing_events (missinglimit), then
// /state_ids + /event for the gap tips behind held placeholders and
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
import { eventIdFor } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { StateMap } from '#engine/rulebook/index.ts';
import {
  loadRulebookStore,
  roomVersionOf,
  ungroundedPrevs,
} from '#engine/room/build.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { projectAfterWrite } from '#engine/room/hooks.ts';
import { ingestInTx, resumeWaits } from '#engine/room/ingest.ts';
import type { Room } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { identify, verify } from '#engine/room/verify.ts';

function byDepthThenId(
  a: { eventId: string; pdu: Pdu },
  b: { eventId: string; pdu: Pdu },
): number {
  if (a.pdu.depth !== b.pdu.depth) return a.pdu.depth - b.pdu.depth;
  return a.eventId < b.eventId ? -1 : 1;
}

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
  pdu: Pdu;
  eventId: string;
  oversized: boolean;
};

// Everything the unlocked fetch phase gathers for the locked batch.
type FetchAcc = {
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

// The bounded fetch ladder for one PDU with ungrounded prevs (old §3.4),
// all with the room lock RELEASED: the brief wait, ONE
// get_missing_events, then /state_ids + /event for the gap tips — never
// for an id we hold or one this chain proved terminal.
async function fetchMissing(
  room: Room,
  item: VerifiedItem,
  origin: string,
  deps: RemoteDeps,
  version: string,
  budget: { until: number },
  acc: FetchAcc,
): Promise<void> {
  const missingNow = async (): Promise<string[]> =>
    await room.tx(async (tx) =>
      await ungroundedPrevs(tx, item.pdu.prev_events ?? [])
    );
  const budgetLeft = () => budget.until - Date.now();
  let missing = await missingNow();
  if (missing.length === 0) return;

  // 1. WAIT missingwaitms, waking early when the prevs arrive (the
  //    sender usually pushes them next) — the lock is NOT held meanwhile
  {
    const deadline = Date.now() +
      Math.min(deps.limits.waitMs, Math.max(0, budgetLeft()));
    while (missing.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      missing = await missingNow();
    }
  }
  if (missing.length === 0) return;

  // 2. ONE get_missing_events (backfill.yaml:71-141): earliest = our
  //    current forward extremities, latest = the pushed PDU, limit =
  //    missinglimit. Verified answers land live; a verify failure is a
  //    drop and terminal for its cited id in this chain (…BadJSON).
  if (budgetLeft() > 0) {
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
      );
    } catch {
      // the fetch failed outright — fall through to the chase
    }
    let dropped = 0;
    for (const raw of answered) {
      try {
        const v = await verify(raw, version, deps.keys, { roomId: room.id });
        acc.live.set(v.eventId, {
          index: -1,
          pdu: v.pdu,
          eventId: v.eventId,
          oversized: v.oversized,
        });
      } catch {
        dropped++;
      }
    }
    // a dropped answer can leave the pushed PDU's prev dangling under the
    // CITED id (authored under different redaction rules, our computed id
    // differs from the citation): tombstone the cited prev in this chain
    // or the chase asks /state_ids for it forever (…BadJSONForRoomVersion6)
    if (dropped > 0 && missing.length === 1) acc.terminal.add(missing[0]);
  }

  // 3. /state_ids + /event for the GAP TIPS (at most missinglimit state
  //    fetches, the whole chain inside the batch budget): a prev we HOLD
  //    (pending or evidence) is never /state_ids'd — the gap behind it is
  const gapTips: string[] = [];
  const chased = new Set<string>();
  const chase = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) {
      if (
        chased.has(id) || acc.terminal.has(id) ||
        gapTips.length >= deps.limits.limit
      ) {
        continue;
      }
      chased.add(id);
      // an event the answer already landed joins this batch — it is
      // "held" for the chase: never /state_ids'd, the gap is behind it
      const answered = acc.live.get(id);
      if (answered !== undefined) {
        await chase(answered.pdu.prev_events ?? []);
        continue;
      }
      const grounding = await groundingOf(room, id);
      if (grounding === 'grounded') continue;
      if (grounding === 'unknown') {
        gapTips.push(id);
        continue;
      }
      const prevs = await room.tx((tx) => tx.events.prevsOf(id));
      await chase(prevs);
    }
  };
  await chase(item.pdu.prev_events ?? []);
  for (const tip of gapTips) {
    if (budgetLeft() <= 0) return;
    await fetchGapTip(room, tip, origin, deps, version, budget, acc);
  }

  // 4. missing DECLARED AUTH events of everything we are about to ingest
  //    (this PDU plus what the answer landed) — one /event_auth per
  //    event, inside the budget
  if (budgetLeft() > 0) {
    const want = [item, ...(acc.live.values().filter((v) => v.index === -1))];
    for (const target of want) {
      const declared = target.pdu.auth_events ?? [];
      if (declared.length === 0) continue;
      const missingAuth: string[] = [];
      for (const id of declared) {
        if (acc.evidence.has(id) || acc.live.has(id)) continue;
        if ((await groundingOf(room, id)) === 'unknown') missingAuth.push(id);
      }
      if (missingAuth.length === 0) continue;
      if (budgetLeft() <= 0) return;
      const chain = await deps.fetcher.eventAuth(
        room.id,
        target.eventId,
        origin,
      );
      if (chain === null) continue;
      // wire form has no id yet — depth order, stable ties
      const sorted = [...chain].sort((a, b) => a.depth - b.depth);
      for (const raw of sorted.slice(0, deps.limits.limit)) {
        try {
          const v = await verify(raw, version, deps.keys, {
            roomId: room.id,
          });
          if (!acc.live.has(v.eventId)) acc.evidence.set(v.eventId, v.pdu);
        } catch {
          // an unverifiable auth-chain event is simply not evidence
        }
      }
    }
  }
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
  const ids = await deps.fetcher.stateIds(room.id, tip, origin);
  if (ids === null) return;
  const authSet = new Set(ids.authChainIds);
  const wanted = [...new Set([...ids.pduIds, ...ids.authChainIds])].sort();
  const unknown = await room.tx(async (tx) => {
    const out: string[] = [];
    for (const id of wanted) {
      if ((await tx.events.get(id)) === null) out.push(id);
    }
    return out;
  });
  const pack = new Map<string, Pdu>();
  let corruptedAuth = false;
  for (const id of unknown.slice(0, deps.limits.limit)) {
    if (budget.until - Date.now() <= 0) return;
    const raw = await deps.fetcher.event(id, origin);
    if (raw === null) {
      if (authSet.has(id)) corruptedAuth = true;
      continue;
    }
    try {
      const v = await verify(raw, version, deps.keys, { roomId: room.id });
      if (v.eventId !== id) {
        if (authSet.has(id)) corruptedAuth = true;
        continue;
      }
      pack.set(id, v.pdu);
    } catch {
      if (authSet.has(id)) corruptedAuth = true;
    }
  }
  // the tip itself via /event
  let tipPdu: Pdu | null = null;
  const rawTip = await deps.fetcher.event(tip, origin);
  if (rawTip !== null) {
    try {
      const v = await verify(rawTip, version, deps.keys, {
        roomId: room.id,
      });
      if (v.eventId === tip) {
        tipPdu = v.pdu;
        acc.live.set(tip, {
          index: -1,
          pdu: v.pdu,
          eventId: tip,
          oversized: v.oversized,
        });
      }
    } catch {
      // stays missing — the caller's terminal decides
    }
  }
  if (tipPdu === null) return;
  if (corruptedAuth) {
    acc.live.delete(tip);
    acc.corrupted.set(tip, tipPdu);
    return;
  }
  // the imported boundary: the remote's state at the event, from the
  // state ids we can read (held events and the just-fetched pack)
  const boundary: StateMap = new Map();
  for (const id of ids.pduIds) {
    const pdu = pack.get(id) ??
      await room.tx(async (tx) => {
        const row = await tx.events.get(id);
        return row === null ? null : (JSON.parse(row.pdu) as Pdu);
      });
    if (pdu === null || pdu.state_key === undefined) continue;
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
export async function ingestRemote(
  room: Room,
  pdus: Pdu[],
  origin: string,
  deps: RemoteDeps,
): Promise<RemoteOutcome[]> {
  const version = await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) {
      throw new Error('E_ROOM_ARCHIVED: no open stay for ' + room.id);
    }
    return await roomVersionOf(tx, stay.id);
  });
  const outcomes: (RemoteOutcome | null)[] = pdus.map(() => null);

  // identify every PDU (format guards, unsigned strip, recomputed id) —
  // a failure is refused before storage
  const identified: { index: number; pdu: Pdu; eventId: string }[] = [];
  for (const [index, pdu] of pdus.entries()) {
    try {
      const pre = await identify(pdu, version, { roomId: room.id });
      identified.push({ index, pdu, eventId: pre.eventId });
    } catch (e) {
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
    const status = knownStatuses.get(item.eventId);
    if (status !== undefined && status.grounding !== 'pending') {
      outcomes[item.index] = outcomeOf(item.eventId, 'known');
      continue;
    }
    try {
      const v = await verify(item.pdu, version, deps.keys, {
        roomId: room.id,
      });
      items.push({
        index: item.index,
        pdu: v.pdu,
        eventId: v.eventId,
        oversized: v.oversized,
      });
    } catch (e) {
      outcomes[item.index] = outcomeOf(item.eventId, 'refused', String(e));
    }
  }

  // The unlocked fetch phase: gather what is missing before the lock,
  // inside the whole-batch budget (R13 — network never under the lock)
  const acc: FetchAcc = {
    live: new Map(),
    evidence: new Map(),
    corrupted: new Map(),
    boundaries: new Map(),
    terminal: new Set(),
  };
  const budget = { until: Date.now() + deps.limits.budgetMs };
  for (const item of items) {
    await fetchMissing(room, item, origin, deps, version, budget, acc);
  }

  // One room transaction for the accepted batch, under the per-room lock
  const outcomeIndex = new Map<string, number[]>();
  for (const item of items) {
    const indexes = outcomeIndex.get(item.eventId) ?? [];
    indexes.push(item.index);
    outcomeIndex.set(item.eventId, indexes);
  }
  const committed = await withRoomLock(room.id, () =>
    room.tx(async (tx) => {
      const grounded: string[] = [];
      const results = new Map<number, RemoteOutcome>();
      // Revalidation (G8): the fetch phase ran unlocked — the stay, the
      // version and the extremities are re-read inside the lock
      const stay = await tx.segments.openStay();
      if (stay === null) {
        throw new Error('E_ROOM_ARCHIVED: no open stay for ' + room.id);
      }
      const lockedVersion = await roomVersionOf(tx, stay.id);
      const rulebook = getRulebook(lockedVersion);

      // The ingest set: pushed PDUs and fetched live events, deduplicated
      // (a pushed PDU wins over its fetched copy), in depth/topology
      // order — deterministic, so tests pin results
      const merged = new Map<string, VerifiedItem>();
      for (const [id, item] of acc.live) merged.set(id, item);
      for (const item of items) merged.set(item.eventId, item);
      const ordered = [...merged.values()].sort(byDepthThenId);

      // Evidence: verified fetched events, stored with grounding evidence
      // after their own auth check against their auth events (held +
      // pack); corrupted gap tips are standing rejected records. Neither
      // is ever state-at-event (G2), positioned or published.
      const pack = new Map<string, Pdu>([
        ...acc.evidence,
        ...acc.corrupted,
      ]);
      const held = await loadRulebookStore(tx, [
        ...pack.keys(),
        ...[...pack.values()].flatMap((pdu) => pdu.auth_events ?? []),
      ]);
      const store = {
        get: (id: string) => pack.get(id) ?? held.get(id),
        isRejected: (id: string) => held.isRejected(id),
      };
      for (const [id, pdu] of pack) {
        if (merged.has(id)) continue; // fully ingested beats evidence
        if ((await tx.events.get(id)) !== null) continue; // first-writer
        const corrupted = acc.corrupted.has(id);
        const chain = corrupted ? null : rulebook.checkAuthChain(pdu, store);
        const rejected = corrupted || chain === null || !chain.ok;
        await tx.events.insert(
          id,
          canonicalJson(pdu as unknown as Record<string, unknown>),
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
      }

      // Every event through the shared locked pipeline: auth events,
      // state before (resolved from its prevs — or the imported boundary
      // for a gap tip), current state → soft-fail; accepted ones update
      // extremities, event-state refs, current state via materialize,
      // the change log
      for (const item of ordered) {
        const res = await ingestInTx(tx, room.id, item.pdu, {
          remote: {
            origin,
            self: deps.self,
            oversized: item.oversized,
            ungroundedMs: deps.ungroundedMs,
            boundary: acc.boundaries.get(item.eventId),
          },
        });
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
        for (const index of outcomeIndex.get(item.eventId) ?? []) {
          results.set(index, result);
        }
      }
      return { grounded, results };
    }));
  for (const [index, result] of committed.results) outcomes[index] = result;

  // A later arrival re-runs what waited for it (R10 — each recheck is a
  // locked ingest of its own, after this lock released)
  const hasWaiters = await room.tx(async (tx) => {
    for (const id of committed.grounded) {
      if ((await tx.waits.for(id)).length > 0) return true;
    }
    return false;
  });
  if (hasWaiters) await resumeWaits(room, { self: deps.self });
  await projectAfterWrite(room.store, room.id);

  return outcomes.map((outcome) =>
    outcome ?? outcomeOf(null, 'refused', 'E_OUTCOME_MISSING')
  );
}
