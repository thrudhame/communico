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
  roomVersionOf,
  stateBefore,
  ungroundedPrevs,
} from '#engine/room/build.ts';
import type { Fetcher, KeyResolver } from '#engine/room/deps.ts';
import type { Room } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { orderEvents } from '#engine/room/order.ts';
import { mapEntries } from '#engine/room/state.ts';
import { verify } from '#engine/room/verify.ts';

export type BackfillDeps = { keys: KeyResolver; fetcher: Fetcher };

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
  const ids = await deps.fetcher.stateIds(room.id, at, via);
  if (ids === null) return null;
  const wanted = [...new Set([...ids.pduIds, ...ids.authChainIds])].sort();
  const unknown = await room.tx(async (tx) => {
    const out: string[] = [];
    for (const id of wanted) {
      if ((await tx.events.get(id)) === null) out.push(id);
    }
    return out;
  });
  const pack = new Map<string, Pdu>();
  for (const id of unknown) {
    const raw = await deps.fetcher.event(id, via);
    if (raw === null) return null;
    try {
      const v = await verify(raw, version, deps.keys, {
        roomId: room.id,
        exemptPrevAuthLimits: true,
      });
      if (v.eventId !== id) return null;
      pack.set(id, v.pdu);
    } catch {
      return null;
    }
  }
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
  return { boundary, pack };
}

// Fetch one page from `via` and land it in the stay's history segment.
// `from` are the gap-facing prev ids (the walk's frontier); `stay`
// names the stay whose history segment receives the page (the default
// is the live — or latest — stay, the common case); `via` is one
// server — trying the next is the caller's loop.
export async function backfill(
  room: Room,
  args: { from: string[]; limit: number; via: string; stay?: number },
  deps: BackfillDeps,
): Promise<BackfillResult> {
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
    return { stay, version: await roomVersionOf(tx, stay.id) };
  });
  if (stayRow === null) throw new Error('M_ROOM_NOT_FOUND: ' + room.id);
  const version = stayRow.version;

  // The fetch phase (never under the lock): the page, each event
  // verified. A fetch/verify failure drops the event; nothing verified
  // means the gap is unresolved.
  let answered: Pdu[];
  try {
    answered = await deps.fetcher.backfill(
      room.id,
      args.from,
      args.limit,
      args.via,
    );
  } catch {
    return empty;
  }
  const page: PageItem[] = [];
  const seen = new Set<string>();
  for (const raw of answered) {
    try {
      const v = await verify(raw, version, deps.keys, {
        roomId: room.id,
        exemptPrevAuthLimits: true,
      });
      if (seen.has(v.eventId)) continue;
      seen.add(v.eventId);
      page.push({ pdu: v.pdu, eventId: v.eventId });
    } catch {
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

  return await withRoomLock(room.id, () =>
    room.tx(async (tx) => {
      // Revalidation (G8): the fetch phase ran unlocked.
      const stay = args.stay === undefined
        ? (await tx.segments.openStay()) ?? await tx.segments.latestStay()
        : await tx.segments.get(args.stay);
      if (stay === null || stay.kind !== 'stay') {
        throw new Error('E_ROOM_ARCHIVED: no stay for ' + room.id);
      }
      const rulebook = getRulebook(await roomVersionOf(tx, stay.id));
      let history = await tx.segments.historyOf(stay.id);
      if (history === null) {
        const id = await tx.segments.create({ kind: 'history', prev: stay.id });
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
      const positionedCandidates = new Set(ordered.map((item) => item.eventId));
      for (const item of allOrdered) {
        localRejected.delete(item.eventId);
        if (!positionedCandidates.has(item.eventId)) {
          const { eventId: id, pdu } = item;
          if ((await tx.events.get(id)) !== null) continue;
          const chain = checkDeclaredAuth(pdu, rulebook, store);
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
          !authorizedBoundary(classification.boundary, store);
        if (
          absent.length > 0 &&
          (classification.kind !== 'imported' || invalidBoundary)
        ) {
          // the boundary fetch failed for it (or for a page parent):
          // evidence — held, auth-checked, never positioned
          const chain = invalidBoundary
            ? { ok: false as const, rule: 'unverifiable' }
            : checkDeclaredAuth(item.pdu, rulebook, store);
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
          beforeGroup = await tx.materialize.newGroup(null, mapEntries(before));
          provenance = 'imported';
        }

        let standing: 'accepted' | 'rejected' = 'accepted';
        let reason: 'auth' | 'state' | null = null;
        let rule: string | null = null;
        const chain = checkDeclaredAuth(item.pdu, rulebook, store);
        if (!chain.ok) {
          standing = 'rejected';
          reason = 'auth';
          rule = chain.rule;
        } else {
          const state = rulebook.checkAuthAgainstState(item.pdu, before, store);
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
      const offsets = await tx.segments.prependPositions(
        history.id,
        positioned,
      );
      const offsetOf = new Map(
        positioned.map((id, index) => [id, offsets[index]]),
      );
      for (const entry of stored) {
        await tx.changes.append('history', entry.id, {
          standing: entry.standing,
          reason: entry.reason,
          rule: entry.rule,
          type: String(entry.pdu.type),
          state_key: entry.pdu.state_key ?? null,
          sender: String(entry.pdu.sender),
          depth: entry.pdu.depth,
          origin_server_ts: entry.pdu.origin_server_ts,
          segment: history.id,
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
      if (complete) await tx.segments.close(history.id);
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
}
