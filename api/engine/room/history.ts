// api/engine/room/history.ts — backfill into history segments (3c-2):
// older events fetched from another server land in the stay's history
// segment, fully authorized per event, never news ("history is never
// news" — R8/requirements §5: no live positions, no publications, no
// delivery intents, change-log entries of kind 'history'). The fetch
// runs OUTSIDE the room lock (R13): the page through Fetcher.backfill,
// every answered event through the ONE verification path (verify.ts
// with the /backfill count exemption — backfill.yaml's note), and
// /state_ids + /event for the page-edge events whose prevs are absent
// (the imported boundary, R5/G1 — or grounding 'evidence' when that
// fails). Under the lock, in one room transaction: topology order
// (never a depth-linear shared map — G4), each event's own auth-chain
// and state-before checks, explicit before/after refs (G3), held
// evidence promoted and first-owner positions prepended (R8 — old
// cursors never renumber). The gap is COMPLETE when the page's boundary
// events' prevs are all grounded (the create is such an event).
import { canonicalJson } from '#engine/canonical.ts';
import { aclAllows } from '#engine/room/acl.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  type EventStore,
  getRulebook,
  type StateMap,
} from '#engine/rulebook/index.ts';
import {
  authorizedBoundary,
  checkDeclaredAuth,
  loadRulebookStore,
  resolvePrevs,
  roomCreateId,
  roomVersionOf,
  stateBefore,
  ungroundedPrevs,
} from '#engine/room/build.ts';
import {
  type Fetcher,
  fetchOrNull,
  type KeyResolver,
} from '#engine/room/deps.ts';
import { afterRoomCommit } from '#engine/room/ingest.ts';
import type { Room } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { orderEvents } from '#engine/room/order.ts';
import { mapEntries } from '#engine/room/state.ts';
import { verify } from '#engine/room/verify.ts';
import { fetchBoundaryEvents } from '#engine/room/boundary-fetch.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';

export type BackfillDeps = {
  self: string;
  keys: KeyResolver;
  fetcher: Fetcher;
  signal?: AbortSignal;
  // Shared by a forward bridge's multiple pages, never reset per boundary.
  budget?: HistoryBudget;
};

type HistoryBudget = {
  signal: AbortSignal;
  requests: number;
  work: number;
  exhausted: boolean;
};

class HistoryExhausted extends Error {}

function historyDeps(
  deps: BackfillDeps,
): BackfillDeps & { budget: HistoryBudget } {
  const budget = deps.budget ?? {
    signal: deps.signal === undefined
      ? AbortSignal.timeout(8000)
      : AbortSignal.any([deps.signal, AbortSignal.timeout(8000)]),
    requests: 128,
    work: 10_000,
    exhausted: false,
  };
  return { ...deps, signal: budget.signal, budget };
}

function spend(budget: HistoryBudget, work: number, requests = 0): boolean {
  if (
    budget.exhausted || budget.signal.aborted ||
    budget.work < work || budget.requests < requests
  ) {
    budget.exhausted = true;
    return false;
  }
  budget.work -= work;
  budget.requests -= requests;
  return true;
}

// Bound even an injected fetcher that fails to honor cancellation. Real
// federation fetches also receive the signal, so the transport closes its I/O.
async function historyFetch<T>(
  deps: BackfillDeps,
  read: () => Promise<T | null>,
): Promise<T | null> {
  const signal = deps.signal!;
  return await fetchOrNull(async () => {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([read(), cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }, signal);
}

export type BackfillResult = {
  // filled: the gap moved; complete: the gap closed (all boundary prevs
  // grounded); open: nothing grounded (a failed/empty page).
  outcome: 'filled' | 'open' | 'complete';
  // the stay's history segment the page landed in (null when nothing
  // verified — no segment is created for an empty answer)
  segment: number | null;
  // events that gained a (first-owner) history position, oldest first
  positioned: string[];
};

type PageItem = { pdu: Pdu; eventId: string };

type Classification =
  | { kind: 'dag' }
  | { kind: 'imported'; boundary: StateMap }
  | { kind: 'evidence' };

// /state_ids + /event for one page-edge event: the answer's state ids
// are the event's imported before-state (G1); the unknown state/auth
// events are fetched and verified (G4 — the old path only recomputed
// their ids). A failed state_ids, or an unfetchable/unverifiable piece
// of the answer, fails the whole boundary: the event lands 'evidence'.
async function fetchBoundary(
  room: Room,
  at: string,
  via: string,
  version: string,
  deps: BackfillDeps,
): Promise<{ boundary: StateMap; pack: Map<string, Pdu> } | null> {
  const budget = deps.budget!;
  if (!spend(budget, 1, 1)) return null;
  const ids = await historyFetch(
    deps,
    () => deps.fetcher.stateIds(room.id, at, via, deps.signal),
  );
  if (ids === null) return null;
  const wanted = [...new Set([...ids.pduIds, ...ids.authChainIds])].sort();
  // A boundary that cannot fit is unavailable evidence, not consumption of
  // the operation's remaining allowance. Retain the verified page and allow
  // its other boundaries/peers to progress; never import a partial state map.
  if (wanted.length > budget.work) return null;
  if (!spend(budget, wanted.length)) return null;
  const unknown = await room.tx(async (tx) => {
    const held = await tx.events.list(wanted);
    return wanted.filter((id) => !held.has(id));
  });
  if (unknown.length > budget.work) {
    return null;
  }
  const pack = await fetchBoundaryEvents(unknown, wanted.length, {
    roomId: room.id,
    at,
    via,
    version,
    fetcher: deps.fetcher,
    keys: deps.keys,
    signal: deps.signal,
    concurrency: 1,
    active: () => spend(budget, 0),
    work: () => spend(budget, 1),
    canReadAll: (count, reservedRequests = 0) =>
      count + reservedRequests <= budget.requests && count <= budget.work,
    read: (op) =>
      spend(budget, 0, 1) ? historyFetch(deps, op) : Promise.resolve(null),
    exemptPrevAuthLimits: true,
  });
  if (pack === null || pack.size !== unknown.length) return null;
  const boundary: StateMap = new Map();
  for (const id of ids.pduIds) {
    const pdu = pack.get(id) ??
      await room.tx(async (tx) => {
        const row = await tx.events.get(id);
        return row === null ? null : (JSON.parse(row.pdu) as Pdu);
      });
    if (pdu === null || pdu.state_key === undefined) return null;
    boundary.set(String(pdu.type) + '\0' + String(pdu.state_key), id);
  }
  return { boundary, pack };
}

// Fetch one page from `via` and land it in the stay's history segment.
// `from` are the gap-facing prev ids (the walk's frontier); `stay`
// names the stay whose history segment receives the page (the default
// is the live — or latest — stay, the common case); `via` is one
// server — trying the next is the caller's loop.
// Resolve an isolated anchor's forward gap from held newer boundaries. A
// backfill imports only verified/authenticated history and retains first owners;
// the segment walk crosses only when it can observe an actual positioned child.
// Progress is durable between bounded pagination requests, not an empty forever
// cursor and not a made-up connection to the anchor's owning stay.
export async function bridgeForwardAnchor(
  room: Room,
  cursor: { segment: number; offset: number },
  peers: string[],
  limit: number,
  deps: BackfillDeps,
): Promise<boolean> {
  deps = historyDeps(deps);
  const signal = deps.signal!;
  const boundaries = await room.tx(async (tx) => {
    const out: { stay: number; segment?: number; from: string[] }[] = [];
    const segments = await tx.segments.list();
    const owner = (await tx.segments.get(cursor.segment))?.prev;
    segments.sort((a, b) =>
      Number(b.id === owner) - Number(a.id === owner) || a.id - b.id
    );
    for (const segment of segments) {
      if (segment.id === cursor.segment) continue;
      const first = await tx.segments.positionsPage(
        segment.id,
        -Number.MAX_SAFE_INTEGER,
        'f',
        1,
      );
      if (first.length === 0) continue;
      const missing: string[] = [];
      for (const prev of await tx.events.prevsOf(first[0].event)) {
        if (await tx.state.eventStateAfter(prev) === null) missing.push(prev);
      }
      if (missing.length > 0) {
        out.push({
          stay: segment.kind === 'stay' ? segment.id : segment.prev!,
          ...(segment.kind === 'anchor' ? { segment: segment.id } : {}),
          from: missing,
        });
      }
      if (out.length === 3) break;
    }
    return out;
  });
  let progress = false;
  for (const boundary of boundaries) {
    for (const via of peers.slice(0, 3)) {
      if (signal.aborted) return progress;
      const result = await backfill(room, { ...boundary, via, limit }, {
        ...deps,
        signal,
      });
      if (result.outcome !== 'open') {
        progress = true;
        break;
      }
    }
    if ((await room.tx((tx) => tx.segments.step(cursor, 'f'))).kind !== 'gap') {
      break;
    }
  }
  return progress;
}

export async function backfill(
  room: Room,
  args: {
    from: string[];
    limit: number;
    via: string;
    stay?: number;
    segment?: number;
    anchor?: Pdu;
    // A missing edge inside a live stay needs its own history anchor, not the
    // stay's pre-join history prefix. First-owner prev edges reconnect it.
    isolated?: boolean;
  },
  deps: BackfillDeps,
): Promise<BackfillResult> {
  deps = historyDeps(deps);
  const budget = deps.budget!;
  const empty: BackfillResult = {
    outcome: 'open',
    segment: null,
    positioned: [],
  };
  const stayRow = await room.tx(async (tx) => {
    const stay = args.stay === undefined
      ? (await tx.segments.openStay()) ?? await tx.segments.latestStay()
      : await tx.segments.get(args.stay);
    if (stay === null || stay.kind !== 'stay') return null;
    return {
      stay,
      version: await roomVersionOf(tx, stay.id),
      allowed: await aclAllows(tx, args.via),
    };
  });
  if (stayRow === null) throw new Error('M_ROOM_NOT_FOUND: ' + room.id);
  if (!stayRow.allowed) return empty;
  const version = stayRow.version;

  // The fetch phase (never under the lock): the page, each event
  // verified. A fetch/verify failure drops the event; nothing verified
  // means the gap is unresolved.
  let answered: Pdu[];
  if (!spend(budget, 1, args.anchor === undefined ? 1 : 0)) return empty;
  try {
    answered = args.anchor !== undefined
      ? [args.anchor]
      : await historyFetch(deps, () =>
        deps.fetcher.backfill(
          room.id,
          args.from,
          args.limit,
          args.via,
          deps.signal,
        )) ?? [];
  } catch (error) {
    if (!recoverableUpstream(error, deps.signal)) throw error;
    return empty;
  }
  const page: PageItem[] = [];
  if (!spend(budget, answered.length)) return empty;
  const seen = new Set<string>();
  for (const raw of answered) {
    if (!spend(budget, 0)) return empty;
    try {
      const v = await verify(raw, version, deps.keys, {
        roomId: room.id,
        exemptPrevAuthLimits: true,
      });
      if (seen.has(v.eventId)) continue;
      seen.add(v.eventId);
      page.push({ pdu: v.pdu, eventId: v.eventId });
    } catch (error) {
      if (!recoverableUpstream(error, deps.signal)) throw error;
      continue;
    }
  }
  if (page.length === 0) return empty;
  const orderedAll = orderEvents(page, ['prev_events', 'auth_events']);
  const pageIds = new Set(page.map((item) => item.eventId));

  // Held-grounding snapshot (grounding only grows, so the locked pass
  // can only resolve MORE).
  const heldGrounded = await room.tx(async (tx) => {
    const cited = new Set<string>();
    for (const item of orderedAll) {
      cited.add(item.eventId);
      for (const prev of item.pdu.prev_events ?? []) cited.add(prev);
    }
    const set = new Set<string>();
    for (const id of cited) {
      const row = await tx.events.get(id);
      if (row !== null && (await tx.state.eventStateAfter(id)) !== null) {
        set.add(id);
      }
    }
    return set;
  });

  // The overlap cut (requirements §5 row 5: the first held grounded
  // event ends this segment's fetch — first chapter wins, nothing is
  // relocated): everything OLDER than an already-grounded page event
  // stays for the previous stay's history, discovered by the frontier
  // behind that held event in its own segment.
  const dropped = new Set<string>();
  const pageById = new Map(page.map((item) => [item.eventId, item]));
  const cut = (id: string): void => {
    const parents = (pageById.get(id)?.pdu.prev_events ?? []).filter(
      (prev) => pageIds.has(prev),
    );
    for (const parent of parents) {
      if (!dropped.has(parent)) {
        dropped.add(parent);
        cut(parent);
      }
    }
  };
  for (const item of orderedAll) {
    if (heldGrounded.has(item.eventId)) cut(item.eventId);
  }
  const ordered = orderedAll.filter((item) => !dropped.has(item.eventId));
  if (ordered.length === 0) {
    // the page is entirely behind held events: the overlap itself
    return { outcome: 'complete', segment: null, positioned: [] };
  }

  // Pre-lock classification (grounding only grows, so the locked pass
  // can only resolve MORE): each page event resolves from its prevs
  // ('dag'), takes an imported boundary when some prev is absent
  // (G1), or lands 'evidence' when the boundary fetch fails.
  const classified = new Map<string, Classification>();
  const evidencePack = new Map<string, Pdu>();
  const groundedPage = new Set<string>();
  for (const item of ordered) {
    if (!spend(budget, 0)) return empty;
    if (heldGrounded.has(item.eventId)) {
      // already grounded (the overlap) — first writer wins; it still
      // grounds its page children
      classified.set(item.eventId, { kind: 'dag' });
      groundedPage.add(item.eventId);
      continue;
    }
    const absent = (item.pdu.prev_events ?? []).filter((prev) =>
      !heldGrounded.has(prev) && !groundedPage.has(prev)
    );
    if (absent.length === 0) {
      classified.set(item.eventId, { kind: 'dag' });
      groundedPage.add(item.eventId);
      continue;
    }
    const fetched = await fetchBoundary(
      room,
      item.eventId,
      args.via,
      version,
      deps,
    );
    if (fetched === null) {
      // state_ids failed — held bytes, never state-at; page children
      // cascade to their own boundary fetch
      classified.set(item.eventId, { kind: 'evidence' });
      continue;
    }
    for (const [id, pdu] of fetched.pack) evidencePack.set(id, pdu);
    classified.set(item.eventId, {
      kind: 'imported',
      boundary: fetched.boundary,
    });
    groundedPage.add(item.eventId);
  }

  if (!spend(budget, 0)) return empty;
  let written: BackfillResult;
  try {
    written = await withRoomLock(room.id, () =>
      room.tx(async (tx) => {
        // Revalidation (G8): the fetch phase ran unlocked.
        if (!spend(budget, 0)) return empty;
        // A policy refusal is the same unresolved page as a refused fetch, not a
        // caller exception. Every pagination/search caller can keep its local
        // result and try the next peer; storage faults still propagate.
        if (!await aclAllows(tx, args.via)) return empty;
        const stay = args.stay === undefined
          ? (await tx.segments.openStay()) ?? await tx.segments.latestStay()
          : await tx.segments.get(args.stay);
        if (stay === null || stay.kind !== 'stay') {
          throw new Error('E_ROOM_ARCHIVED: no stay for ' + room.id);
        }
        const rulebook = getRulebook(await roomVersionOf(tx, stay.id));
        const createId = await roomCreateId(tx, stay.id);
        let history = args.segment === undefined
          ? args.anchor === undefined && !args.isolated
            ? await tx.segments.historyOf(stay.id)
            : null
          : await tx.segments.get(args.segment);
        if (
          args.segment !== undefined &&
          (history === null || history.kind === 'stay' ||
            history.prev !== stay.id)
        ) {
          throw new Error('E_HISTORY_OWNER: invalid history target');
        }
        if (history === null && args.anchor === undefined && !args.isolated) {
          const id = await tx.segments.create({
            kind: args.isolated ? 'anchor' : 'history',
            prev: stay.id,
            opened_by: args.anchor === undefined ? null : ordered[0].eventId,
          });
          history = (await tx.segments.get(id))!;
        }

        // The rulebook store: held events plus the page and the fetched
        // evidence; rejections decided in this pass ride along.
        const seeds = new Set<string>();
        for (const item of ordered) {
          for (const id of item.pdu.auth_events ?? []) seeds.add(id);
        }
        for (const [id, pdu] of evidencePack) {
          seeds.add(id);
          for (const auth of pdu.auth_events ?? []) seeds.add(auth);
        }
        for (const classification of classified.values()) {
          if (classification.kind === 'imported') {
            for (const id of classification.boundary.values()) seeds.add(id);
          }
        }
        const candidates = new Map<string, PageItem>();
        for (const [eventId, pdu] of evidencePack) {
          candidates.set(eventId, { eventId, pdu });
        }
        for (const item of ordered) {
          candidates.set(item.eventId, item);
        }
        const allOrdered = orderEvents([...candidates.values()], [
          'prev_events',
          'auth_events',
        ], (item) => {
          const c = classified.get(item.eventId);
          return c?.kind === 'imported' ? [...c.boundary.values()] : [];
        });
        const localRejected = new Set<string>(candidates.keys());
        const store: EventStore = await loadRulebookStore(tx, [...seeds], [
          ...candidates.values().map((item) => item.pdu),
        ], localRejected);

        // The page, in topology order: each event's own auth-chain and
        // state-before checks, explicit before/after refs, first-owner
        // positions. Rejected events get pass-through refs and no
        // position; already-grounded events are the overlap (first writer
        // wins — never relocated).
        type Stored = {
          id: string;
          pdu: Pdu;
          standing: 'accepted' | 'rejected';
          reason: 'auth' | 'state' | null;
          rule: string | null;
          grounding: 'grounded' | 'evidence';
        };
        const stored: Stored[] = [];
        const overlapped: string[] = [];
        const positionedCandidates = new Set(
          ordered.map((item) => item.eventId),
        );
        for (const item of allOrdered) {
          if (!spend(budget, 0)) throw new HistoryExhausted();
          localRejected.delete(item.eventId);
          if (!positionedCandidates.has(item.eventId)) {
            const { eventId: id, pdu } = item;
            if ((await tx.events.get(id)) !== null) continue;
            const chain = checkDeclaredAuth(pdu, rulebook, store, createId);
            if (!chain.ok) localRejected.add(id);
            await tx.events.insert(
              id,
              canonicalJson(pdu as unknown as Record<string, unknown>),
            );
            await tx.events.setStatus(id, {
              standing: chain.ok ? 'accepted' : 'rejected',
              grounding: 'evidence',
              origin: args.via,
              received_ts: Date.now(),
            });
            await tx.changes.append('event', id, {
              standing: chain.ok ? 'accepted' : 'rejected',
              reason: chain.ok ? null : 'auth',
              rule: chain.ok ? null : chain.rule,
              type: pdu.type,
              state_key: pdu.state_key ?? null,
              sender: pdu.sender,
              depth: pdu.depth,
              origin_server_ts: pdu.origin_server_ts,
              stay: null,
              offset: null,
              grounding: 'evidence',
              origin: args.via,
            });
            continue;
          }
          const existing = await tx.events.get(item.eventId);
          const refs = existing === null
            ? null
            : await tx.state.eventStateAfter(item.eventId);
          if (existing !== null && refs !== null) {
            // the overlap: first writer wins, never relocated — and it
            // CLOSES this segment's gap: what lies behind the held event
            // belongs to the segment it lives in (the walk's frontier
            // there), not to this history segment
            overlapped.push(item.eventId);
            continue;
          }
          const absent = await ungroundedPrevs(tx, item.pdu.prev_events ?? []);
          const classification = classified.get(item.eventId)!;
          const invalidBoundary = classification.kind === 'imported' &&
            !authorizedBoundary(classification.boundary, store, createId);
          if (
            absent.length > 0 &&
            (classification.kind !== 'imported' || invalidBoundary)
          ) {
            // the boundary fetch failed for it (or for a page parent):
            // evidence — held, auth-checked, never positioned
            const chain = invalidBoundary
              ? { ok: false as const, rule: 'unverifiable' }
              : checkDeclaredAuth(item.pdu, rulebook, store, createId);
            if (!chain.ok) localRejected.add(item.eventId);
            if (existing === null) {
              await tx.events.insert(
                item.eventId,
                canonicalJson(item.pdu as unknown as Record<string, unknown>),
              );
            }
            await tx.events.setStatus(item.eventId, {
              standing: chain.ok ? 'accepted' : 'rejected',
              grounding: 'evidence',
              origin: args.via,
              received_ts: Date.now(),
            });
            stored.push({
              id: item.eventId,
              pdu: item.pdu,
              standing: chain.ok ? 'accepted' : 'rejected',
              reason: chain.ok ? null : 'auth',
              rule: chain.ok ? null : chain.rule,
              grounding: 'evidence',
            });
            continue;
          }

          // before(E): resolved from the prevs — or the imported boundary
          // when some prev is genuinely absent (R5, G1)
          let before: StateMap;
          let beforeGroup: number;
          let provenance: 'dag' | 'imported';
          if (absent.length === 0) {
            const prevs = await resolvePrevs(tx, item.pdu.prev_events ?? []);
            before = await stateBefore(tx, prevs.afterGroups, rulebook, store);
            beforeGroup = prevs.afterGroups.length === 1
              ? prevs.afterGroups[0]
              : await tx.materialize.newGroup(null, mapEntries(before));
            provenance = 'dag';
          } else {
            before = (classification as { boundary: StateMap }).boundary;
            beforeGroup = await tx.materialize.newGroup(
              null,
              mapEntries(before),
            );
            provenance = 'imported';
          }

          let standing: 'accepted' | 'rejected' = 'accepted';
          let reason: 'auth' | 'state' | null = null;
          let rule: string | null = null;
          const chain = checkDeclaredAuth(item.pdu, rulebook, store, createId);
          if (!chain.ok) {
            standing = 'rejected';
            reason = 'auth';
            rule = chain.rule;
          } else {
            const state = rulebook.checkAuthAgainstState(
              item.pdu,
              before,
              store,
            );
            if (!state.ok) {
              standing = 'rejected';
              reason = 'state';
              rule = state.rule;
            }
          }
          if (standing === 'rejected') localRejected.add(item.eventId);

          let afterGroup = beforeGroup;
          if (standing === 'accepted' && item.pdu.state_key !== undefined) {
            afterGroup = await tx.materialize.newGroup(beforeGroup, [{
              type: String(item.pdu.type),
              state_key: String(item.pdu.state_key),
              event: item.eventId,
            }]);
          }

          if (existing === null) {
            await tx.events.insert(
              item.eventId,
              canonicalJson(item.pdu as unknown as Record<string, unknown>),
            );
          }
          const status = await tx.events.getStatus(item.eventId);
          await tx.events.setStatus(item.eventId, {
            standing,
            grounding: 'grounded',
            origin: args.via,
            received_ts: Date.now(),
          });
          await tx.materialize.setEventState(
            item.eventId,
            beforeGroup,
            afterGroup,
            provenance,
          );
          if (status !== null && status.grounding === 'pending') {
            // a pending event promoted by the page: its prev waits are
            // spent (the resume driver sees the grounded status)
            for (const wait of await tx.waits.of(item.eventId)) {
              if (wait.kind === 'prev') {
                await tx.waits.remove(wait.missing, wait.waiting, wait.kind);
              }
            }
          }
          stored.push({
            id: item.eventId,
            pdu: item.pdu,
            standing,
            reason,
            rule,
            grounding: 'grounded',
          });
        }

        // First-owner positions (R8): accepted events only, oldest first,
        // prepended below every existing offset — old cursors never
        // renumber. An event that is also an auth/prev of live events was
        // held as evidence and is promoted HERE (one position, first owner).
        const positioned = stored
          .filter((entry) =>
            entry.grounding === 'grounded' && entry.standing === 'accepted'
          )
          .map((entry) => entry.id);
        if (history === null && positioned.length > 0) {
          const id = await tx.segments.create({
            kind: 'anchor',
            prev: stay.id,
            opened_by: positioned[0],
          });
          history = (await tx.segments.get(id))!;
        }
        const offsets = history === null
          ? []
          : await tx.segments.prependPositions(history.id, positioned);
        const offsetOf = new Map(
          positioned.map((id, index) => [id, offsets[index]]),
        );
        for (const entry of stored) {
          if (!spend(budget, 0)) throw new HistoryExhausted();
          await tx.changes.append('history', entry.id, {
            standing: entry.standing,
            reason: entry.reason,
            rule: entry.rule,
            type: String(entry.pdu.type),
            state_key: entry.pdu.state_key ?? null,
            sender: String(entry.pdu.sender),
            depth: entry.pdu.depth,
            origin_server_ts: entry.pdu.origin_server_ts,
            segment: history?.id ?? null,
            offset: offsetOf.get(entry.id) ?? null,
            grounding: entry.grounding,
            origin: args.via,
          });
        }

        // The gap closes when every boundary event of the processed page
        // (no parents inside the processed set) has all of its prevs
        // grounded — the create is such an event; an imported boundary is
        // not (the gap continues behind it). A held overlap event closes
        // regardless of its own prevs: what lies behind it belongs to the
        // segment it lives in, not to this one.
        const processedIds = new Set(ordered.map((item) => item.eventId));
        const overlappedIds = new Set(overlapped);
        let complete = true;
        for (const item of ordered) {
          if (overlappedIds.has(item.eventId)) continue;
          const inPage = (item.pdu.prev_events ?? []).some((prev) =>
            processedIds.has(prev)
          );
          if (inPage) continue;
          if (
            (await ungroundedPrevs(tx, item.pdu.prev_events ?? [])).length > 0
          ) {
            complete = false;
            break;
          }
        }
        if (!spend(budget, 0)) throw new HistoryExhausted();
        if (history === null) {
          return complete
            ? { outcome: 'complete' as const, segment: null, positioned }
            : empty;
        }
        if (complete) await tx.segments.close(history.id);
        if (!spend(budget, 0)) throw new HistoryExhausted();
        return {
          outcome: complete
            ? 'complete'
            : positioned.length > 0
            ? 'filled'
            : 'open',
          segment: history.id,
          positioned,
        } satisfies BackfillResult;
      }));
  } catch (error) {
    if (error instanceof HistoryExhausted) return empty;
    throw error;
  }
  await afterRoomCommit(room, deps.self);
  return written;
}
