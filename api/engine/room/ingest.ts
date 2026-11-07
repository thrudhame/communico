// api/engine/room/ingest.ts — local ingest (3b) and the shared locked
// pipeline remote ingest composes (3c-1): one room transaction per
// event/batch, under the per-room lock. The pipeline (requirements
// §4.1/§4.3, old ingest's locked steps): version gate and format guards,
// idempotent redelivery, prev grounding, state before (single-prev
// aliases the parent's after-group — never a resolution), auth chain /
// state / current (soft-fail) checks, standing, event + edges + status +
// event-state refs, extremities (accepted events consume their prevs,
// walking back through flagged ancestors), positions, the change log
// (event, publication via the event's change pos, membership change,
// delivery intent), and the current-state publication through
// materialize(). Rejected events are stored too (standing rejected),
// never published, never extremities (G11).
//
// The remote shape (opts.remote): depth and declared-auth-set checks are
// relaxed (old steps 7/10 — remote events passed the bounds in
// verify.ts and rules 1–2 only apply), verify()'s oversized verdict is a
// stored state-reject, the delivering server is recorded as the status
// origin, no delivery intent is emitted (we do not forward remote
// events), prevs that stay missing land the event `pending` with waits
// rows (R10 — or dropped when ungroundedMs is 0), a pending redelivery
// falls through to a real re-ingest (ruling B), and a gap tip recovered
// with a fetched state uses it as the imported before-state boundary
// only when its own prevs are genuinely absent (R5/G1; with grounded
// parents held, their after-states resolve instead — P15). resumeWaits
// is the recheck driver: a later arrival of what a wait missed re-runs
// it (old ruling B).
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { getRulebook, type StateMap } from '#engine/rulebook/index.ts';
import {
  namedLevel,
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from '#engine/rulebook/power-levels.ts';
import { contentHashOf } from '#engine/signing-primitives.js';
import {
  buildInTx,
  type BuildPartial,
  checkDeclaredAuth,
  loadRulebookStore,
  resolvePrevs,
  roomVersionOf,
  stateBefore,
  stayForEvent,
  ungroundedPrevs,
} from '#engine/room/build.ts';
import type { Grounding } from '#engine/room/events.ts';
import { projectAfterWrite } from '#engine/room/hooks.ts';
import type { EventRow, Room, RoomTx } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import {
  redactionEffectAllowed,
  redactionTarget,
} from '#engine/room/redaction.ts';
import type { Signer } from '#engine/room/signer.ts';
import { mapEntries } from '#engine/room/state.ts';
import { oversizedOf } from '#engine/room/verify.ts';

export type Standing = 'accepted' | 'rejected' | 'soft_failed';

export type IngestLocalResult = {
  eventId: string;
  standing: Standing;
  reason: 'auth' | 'state' | null;
  rule: string | null;
  grounding: Grounding;
  // False only for the remote terminal drop (ungroundedMs = 0): the
  // event is not stored at all (old ruling B).
  stored: boolean;
  // True when the result is the idempotency receipt of an event the
  // room already held grounded (no second write).
  receipt: boolean;
  event: EventRow;
};

// The remote shape of an ingest (3c-1): the delivering server, our own
// server name (the I15 stay closure), verify()'s lenient-size verdict,
// the terminal rule for events whose prevs stay missing, and — for a
// gap tip recovered via /state_ids — the imported before-state boundary.
export type RemoteIngest = {
  origin: string;
  self: string;
  oversized: boolean;
  ungroundedMs: number;
  boundary?: StateMap;
};

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function membershipOfPdu(pdu: string): string | null {
  const membership = (JSON.parse(pdu) as Pdu).content?.membership;
  return typeof membership === 'string' ? membership : null;
}

function domainOf(userId: string): string {
  const at = userId.indexOf(':');
  return at === -1 ? userId : userId.slice(at + 1);
}

// Build + ingest as one critical section (old authorAndIngest): the build
// reads the live extremities and the ingest consumes them, so a concurrent
// op always authors on the live tip.
export async function sendLocal(
  room: Room,
  partial: BuildPartial,
  signer: Signer,
): Promise<IngestLocalResult> {
  const result = await withRoomLock(room.id, () =>
    room.tx(async (tx) => {
      const pdu = await buildInTx(tx, room.id, partial, signer);
      return await ingestInTx(tx, room.id, pdu, { self: signer.serverName });
    }));
  // A wait naming this event (a redaction target, a missing prev) is
  // re-run now that it has arrived (R10 — the 3c recheck driver).
  await maybeResume(room, result.eventId, signer.serverName);
  await projectAfterWrite(room.store, room.id);
  return result;
}

// Ingest an already-built local PDU: the per-room lock and the room
// transaction are acquired here (R13). Everything the event writes commits
// or rolls back together (G11). `self` is the authoring Signer's server,
// explicit (R16): the event must carry a signature by it; extra caller-
// verified signatures (a countersigned invite) are allowed.
export async function ingestLocal(
  room: Room,
  pdu: Pdu,
  self: string,
): Promise<IngestLocalResult> {
  const result = await withRoomLock(
    room.id,
    () => room.tx((tx) => ingestInTx(tx, room.id, pdu, { self })),
  );
  await maybeResume(room, result.eventId, self);
  await projectAfterWrite(room.store, room.id);
  return result;
}

// The recheck trigger: an event that gained waiters re-runs them after
// the current lock is released (each recheck is a locked ingest of its
// own; network never runs here).
async function maybeResume(
  room: Room,
  eventId: string,
  self: string,
): Promise<void> {
  const hasWaiters = await room.tx(async (tx) =>
    (await tx.waits.for(eventId)).length > 0
  );
  if (hasWaiters) await resumeWaits(room, { self });
}

// The tx-scoped core: the caller holds the room lock and composes (the
// genesis stay creation, createRoom's sequence, remote batches, rollback
// tests). The local path takes `self` explicitly (R16): the event must
// carry a signature by it — extra caller-verified signatures are allowed
// (the countersigned invite; the caller proves them before ingesting).
export async function ingestInTx(
  tx: RoomTx,
  roomId: string,
  pdu: Pdu,
  opts: { remote?: RemoteIngest; self?: string } = {},
): Promise<IngestLocalResult> {
  const remote = opts.remote ?? null;
  const isCreate = pdu.type === 'm.room.create' &&
    (pdu.prev_events ?? []).length === 0;
  const stay = await stayForEvent(tx, pdu as BuildPartial);
  if (stay === null) {
    throw new Error('E_ROOM_ARCHIVED: no open stay for ' + roomId);
  }
  const version = isCreate
    ? String(pdu.content?.room_version)
    : await roomVersionOf(tx, stay.id);
  const rulebook = getRulebook(version); // unknown: never a default

  // Format guards (the old prechecks): thrown before any write.
  const prevIds = pdu.prev_events ?? [];
  const declaredAuth = pdu.auth_events ?? [];
  if (prevIds.length > 20) {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  if (declaredAuth.length > 10) {
    throw new Error('M_TOO_MANY_AUTH_EVENTS: v11 allows at most 10');
  }
  // unsigned is stripped on receipt — never stored (it is covered by
  // neither the signatures nor the content hash).
  delete pdu.unsigned;
  let expect: string;
  try {
    expect = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      version,
    );
  } catch (e) {
    throw new Error('M_BAD_EVENT: ' + String(e));
  }
  if (expect !== pdu.event_id) {
    throw new Error('M_BAD_EVENT: event_id does not recompute');
  }
  const eventId = String(pdu.event_id);
  if (
    rulebook.spec.roomIdFromCreateEvent && pdu.type === 'm.room.create' &&
    roomId !== '!' + eventId.slice(1)
  ) {
    throw new Error(
      'E_ROOM_ID_MISMATCH: v12 room id is not the create event id',
    );
  }

  // Idempotent redelivery (requirements §4.3 I2): the original receipt,
  // no re-verification. A remote redelivery of a PENDING event falls
  // through to a real re-ingest (ruling B — the first-writer bytes are
  // kept, the record is re-evaluated).
  const existing = await tx.events.get(eventId);
  let pendingRedelivery = false;
  if (existing !== null) {
    const status = await tx.events.getStatus(eventId);
    if (status === null) {
      throw new Error('E_STATUS_MISSING: ' + eventId);
    }
    if (remote !== null && status.grounding === 'pending') {
      pendingRedelivery = true;
    } else {
      return {
        eventId,
        standing: status.standing,
        reason: null,
        rule: null,
        grounding: status.grounding,
        stored: true,
        receipt: true,
        event: existing,
      };
    }
  }

  // The content-hash and signature-presence guards are the LOCAL path's
  // (3b: events are signed in-process by the injected signer; a hash
  // mismatch is a stored auth-reject). Remote PDUs were verified before
  // the lock (verify.ts: a hash mismatch was already redacted, the
  // signature already proven — G9/G10).
  let hashOk = true;
  let self: string;
  if (remote !== null) {
    self = remote.self;
  } else {
    // R16: self is EXPLICIT (the authoring Signer's server), never
    // inferred from the signatures map — a countersigned invite carries
    // the invitee's signature beside ours.
    if (opts.self === undefined) {
      throw new Error(
        'E_SELF_REQUIRED: local ingest takes its own server explicitly',
      );
    }
    self = opts.self;
    hashOk = false;
    try {
      const { event_id: _drop, ...noId } = pdu as unknown as Record<
        string,
        unknown
      >;
      void _drop;
      hashOk = (await contentHashOf(noId)) === pdu.hashes?.sha256;
    } catch (e) {
      throw new Error(
        'M_BAD_EVENT: content cannot be canonicalized — ' + String(e),
      );
    }
    // 3b events are signed in-process by the injected signer; ingest
    // verifies the id and content hash and requires a signature entry BY
    // SELF. Additional signatures are allowed — the caller verified them.
    const signatureServers = Object.keys(pdu.signatures ?? {});
    if (!signatureServers.includes(self)) {
      throw new Error('M_UNAUTHORIZED: PDU signature missing or invalid');
    }
  }

  // Prev grounding and the local depth check (a mismatch is a stored
  // auth-reject, as in the old shared pipeline). A REMOTE event whose
  // prevs stay missing is not an error: it waits as pending (R10) or is
  // dropped (ungroundedMs = 0, old ruling B); its depth is bounded but
  // never recomputed (old step 7). A gap tip's fetched boundary is used
  // only when its prevs are genuinely absent (R5 imported, G1) — with
  // grounded parents held, their after-states resolve instead (P15).
  let prevs: { ids: string[]; afterGroups: number[]; depths: number[] };
  let boundary: StateMap | undefined;
  if (remote !== null) {
    const missing = await ungroundedPrevs(tx, prevIds);
    if (missing.length === 0) {
      prevs = await resolvePrevs(tx, prevIds);
    } else if (remote.boundary !== undefined) {
      boundary = remote.boundary;
      prevs = { ids: [], afterGroups: [], depths: [] };
    } else {
      return await storePending(
        tx,
        pdu,
        eventId,
        missing,
        remote,
        pendingRedelivery,
      );
    }
  } else {
    prevs = await resolvePrevs(tx, prevIds);
  }
  const computedDepth = prevs.ids.length === 0
    ? 1
    : Math.max(...prevs.depths) + 1;
  const depthOk = remote !== null ? true : pdu.depth === computedDepth;

  // The rulebook store: the bounded auth closure over the prevs' (or the
  // imported boundary's) and the current extremities' state ids plus the
  // declared auth ids.
  const extremityIds = await tx.extremities.frontier(stay.id);
  const extremityGroups: number[] = [];
  for (const id of extremityIds) {
    const after = await tx.state.eventStateAfter(id);
    if (after !== null) extremityGroups.push(after.group);
  }
  const seeds = new Set<string>(declaredAuth);
  for (const group of [...prevs.afterGroups, ...extremityGroups]) {
    for (const id of (await tx.state.groupMap(group)).values()) seeds.add(id);
  }
  if (boundary !== undefined) {
    for (const id of boundary.values()) seeds.add(id);
  }
  const store = await loadRulebookStore(tx, [...seeds], [pdu]);

  // The state before: the single prev's after-group aliased, the
  // resolution over all prevs — or the gap tip's imported boundary (the
  // remote's answer, never recomputed from absent prevs, G1).
  const before = boundary !== undefined
    ? boundary
    : await stateBefore(tx, prevs.afterGroups, rulebook, store);
  const priorGroup = await tx.state.current(stay.id);

  // The S8 sequence: auth chain -> state -> soft-fail against the
  // current resolved state. For remote events the declared-set
  // determinism check is relaxed (the declared set must authorize the event,
  // but need not equal our local selection) and verify()'s oversized verdict
  // is a stored state-reject (never a drop).
  let standing: Standing = 'accepted';
  let reason: 'auth' | 'state' | null = null;
  let rule: string | null = null;
  if (remote !== null && remote.oversized) {
    standing = 'rejected';
    reason = 'state';
    rule = 'oversized';
  } else if (!hashOk || !depthOk) {
    standing = 'rejected';
    reason = 'auth';
  } else {
    const chain = checkDeclaredAuth(pdu, rulebook, store);
    const selected = remote !== null || isCreate
      ? null
      : rulebook.selectAuthEvents(pdu, before);
    if (
      !chain.ok ||
      (selected !== null && !sameIdSet(declaredAuth, selected))
    ) {
      standing = 'rejected';
      reason = 'auth';
      rule = chain.ok ? null : chain.rule;
    } else {
      const state = rulebook.checkAuthAgainstState(pdu, before, store);
      if (!state.ok) {
        standing = 'rejected';
        reason = 'state';
        rule = state.rule;
      } else {
        // The current resolved state of the live stay: the published
        // pointer (the resolution over the frontier is what publication
        // records), which is also correct at a stay's birth — the
        // opening group (an imported snapshot) before the first
        // publication (3c-2 joins).
        const currentGroup = await tx.state.current(stay.id);
        const current = currentGroup === null
          ? new Map()
          : await tx.state.groupMap(currentGroup);
        if (!rulebook.checkAuthAgainstState(pdu, current, store).ok) {
          standing = 'soft_failed';
        }
      }
    }
  }

  // Event-state refs (R5): a single parent's before-ref aliases its
  // after-group; a resolved before-map or an imported boundary lands as
  // a fresh snapshot (provenance dag / imported — G1: the boundary is
  // stored, never inferred from absent prevs). The after-map is the
  // before-map plus the event's own key — for accepted AND soft-failed
  // state events (a soft-failed state event is in its own after-state
  // even though it is never published); rejected events get the
  // pass-through map.
  let beforeGroup: number;
  if (boundary !== undefined || prevs.afterGroups.length === 0) {
    beforeGroup = boundary !== undefined
      ? await tx.materialize.newGroup(null, mapEntries(boundary))
      : await tx.materialize.newGroup(null, []);
  } else if (prevs.afterGroups.length === 1) {
    beforeGroup = prevs.afterGroups[0];
  } else {
    beforeGroup = await tx.materialize.newGroup(null, mapEntries(before));
  }
  let afterGroup = beforeGroup;
  if (standing !== 'rejected' && pdu.state_key !== undefined) {
    afterGroup = await tx.materialize.newGroup(beforeGroup, [
      { type: pdu.type, state_key: pdu.state_key, event: eventId },
    ]);
  }

  // Storage (R1/R2): the canonical PDU as truth, its standing, its refs.
  // A pending redelivery keeps the first-writer bytes (the row exists);
  // its refs move from none to genuine groups (placeholder recovery, R2).
  if (existing === null) {
    await tx.events.insert(
      eventId,
      canonicalJson(pdu as unknown as Record<string, unknown>),
    );
  }
  await tx.events.setStatus(eventId, {
    standing,
    grounding: 'grounded',
    origin: remote?.origin ?? null,
    received_ts: Date.now(),
  });
  await tx.materialize.setEventState(
    eventId,
    beforeGroup,
    afterGroup,
    boundary !== undefined ? 'imported' : 'dag',
  );
  if (pendingRedelivery) {
    // grounded now — the prev waits are spent (the redaction waits this
    // event may own are the resume driver's, not ours)
    for (const wait of await tx.waits.of(eventId)) {
      if (wait.kind === 'prev') {
        await tx.waits.remove(wait.missing, wait.waiting, wait.kind);
      }
    }
  }

  // Extremities (R9): only accepted events consume prevs and join the
  // frontier; an accepted child of a soft-failed/rejected event walks back
  // through the flagged chain removing the extremities it finds (E4).
  if (standing === 'accepted') {
    const frontier = new Set(extremityIds);
    const consume = new Set<string>();
    const queue = [...prevs.ids];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (frontier.has(id)) consume.add(id);
      const status = await tx.events.getStatus(id);
      if (status !== null && status.standing !== 'accepted') {
        for (const prev of await tx.events.prevsOf(id)) queue.push(prev);
      }
    }
    if (consume.size > 0) {
      await tx.extremities.remove(stay.id, [...consume]);
    }
    await tx.extremities.add(stay.id, eventId);
  }

  // Positions: accepted events land on the stay's timeline in arrival
  // order; rejected/soft-failed events are change-log entries only. A
  // pending event that now grounds is a standing/grounding TRANSITION
  // (R11) carrying the full payload, not a new event.
  const offset = standing === 'accepted'
    ? await tx.segments.appendPosition(stay.id, eventId)
    : null;
  const payload = {
    standing,
    reason,
    rule,
    type: String(pdu.type),
    state_key: pdu.state_key ?? null,
    sender: String(pdu.sender),
    depth: pdu.depth,
    origin_server_ts: pdu.origin_server_ts,
    stay: stay.id,
    offset,
    grounding: 'grounded',
    origin: remote?.origin ?? null,
  };
  const changePos = pendingRedelivery
    ? await tx.changes.append('transition', eventId, {
      from: { standing: 'rejected', grounding: 'pending' },
      ...payload,
    })
    : await tx.changes.append('event', eventId, payload);

  // Publication (R6/R7): the live stay's current state is the single
  // extremity's after-group or the resolution over the new frontier —
  // published only when it changed. The resolution's store is seeded
  // from the NEW frontier's after-maps: the just-ingested event itself
  // (when it is a state event in the frontier) must be in the resolver's
  // store or its fork is lost (the masked bug the pointer read exposed).
  let publishedGroup: number | null = null;
  if (standing === 'accepted') {
    const newFrontier = await tx.extremities.frontier(stay.id);
    let currentGroup: number;
    if (newFrontier.length === 1) {
      const only = await tx.state.eventStateAfter(newFrontier[0]);
      if (only === null) {
        throw new Error('E_STATE_MISSING: extremity ' + newFrontier[0]);
      }
      currentGroup = only.group;
    } else {
      const groups: number[] = [];
      const pubSeeds = new Set<string>();
      for (const id of newFrontier) {
        const after = await tx.state.eventStateAfter(id);
        if (after !== null) {
          groups.push(after.group);
          for (const value of (await tx.state.groupMap(after.group)).values()) {
            pubSeeds.add(value);
          }
        }
      }
      const pubStore = await loadRulebookStore(tx, [...pubSeeds]);
      const resolved = await stateBefore(tx, groups, rulebook, pubStore);
      currentGroup = await tx.materialize.newGroup(null, mapEntries(resolved));
    }
    if (await tx.materialize.publish(changePos, stay.id, currentGroup)) {
      await tx.materialize.setCurrent(stay.id, currentGroup);
    }
    publishedGroup = currentGroup;
  }

  const stateKey = pdu.state_key === undefined ? null : String(pdu.state_key);

  // Membership change (R11): the published membership of the event's
  // state_key changed across this ingest.
  if (
    standing === 'accepted' && pdu.type === 'm.room.member' &&
    stateKey !== null && publishedGroup !== null
  ) {
    const fromId = priorGroup === null
      ? null
      : await tx.state.groupKey(priorGroup, 'm.room.member', stateKey);
    const toId = await tx.state.groupKey(
      publishedGroup,
      'm.room.member',
      stateKey,
    );
    const fromRow = fromId === null ? null : await tx.events.get(fromId);
    const toRow = toId === null ? null : await tx.events.get(toId);
    const from = fromRow === null ? null : membershipOfPdu(fromRow.pdu);
    const to = toRow === null ? null : membershipOfPdu(toRow.pdu);
    if (from !== to) {
      await tx.changes.append('membership', eventId, {
        user: stateKey,
        from,
        to,
      });
    }
  }

  // Redaction effect (G13): separate from the event's acceptance. The
  // effect applies per the room version's rules, evaluated at the
  // redaction's own before-state; an unknown target waits (R10) for the
  // recheck driver.
  if (standing === 'accepted' && pdu.type === 'm.room.redaction') {
    const target = redactionTarget(pdu);
    if (target !== null) {
      const targetRow = await tx.events.get(target);
      if (targetRow === null) {
        await tx.waits.add({
          missing: target,
          waiting: eventId,
          kind: 'redaction',
          since: Date.now(),
          expires: null,
          state: 'pending',
        });
      } else if (
        await redactionEffectAllowed(
          tx,
          rulebook.spec,
          pdu,
          targetRow,
          beforeGroup,
        )
      ) {
        await tx.changes.append('redaction', eventId, { target });
      }
    }
  }

  // Delivery intent (R11): servers with joined members in the state
  // before OR after the event, plus — for a membership event — the
  // target user's server, excluding this server (the 3c-1 formula; the
  // old-code contract is requirements §4.3 I11). LOCAL events only:
  // remote-origin events get no delivery intent (we do not forward them).
  if (standing === 'accepted' && remote === null) {
    const afterMap = new Map(before);
    if (stateKey !== null) {
      afterMap.set(String(pdu.type) + '\0' + stateKey, eventId);
    }
    const destinations = new Set<string>();
    for (const map of [before, afterMap]) {
      for (const [key, id] of map) {
        if (!key.startsWith('m.room.member\0')) continue;
        const row = await tx.events.get(id);
        if (row === null || membershipOfPdu(row.pdu) !== 'join') continue;
        destinations.add(domainOf(key.slice('m.room.member\0'.length)));
      }
    }
    if (pdu.type === 'm.room.member' && stateKey !== null) {
      destinations.add(domainOf(stateKey));
    }
    destinations.delete(self);
    await tx.changes.append('delivery', eventId, {
      destinations: [...destinations].sort(),
    });
  }

  // The last joined local member's leave/ban closes the stay (I15);
  // the stay's extremities are retained (R9).
  if (
    standing === 'accepted' && pdu.type === 'm.room.member' &&
    stateKey !== null && publishedGroup !== null
  ) {
    const membership = pdu.content?.membership;
    if (
      (membership === 'leave' || membership === 'ban') &&
      domainOf(stateKey) === self
    ) {
      let remains = false;
      for (
        const [key, id] of await tx.state.groupMap(publishedGroup)
      ) {
        if (!key.startsWith('m.room.member\0')) continue;
        if (domainOf(key.slice('m.room.member\0'.length)) !== self) continue;
        const row = await tx.events.get(id);
        if (row !== null && membershipOfPdu(row.pdu) === 'join') {
          remains = true;
          break;
        }
      }
      if (!remains) await tx.segments.close(stay.id);
    }
  }

  const stored = await tx.events.get(eventId);
  if (stored === null) throw new Error('E_STORE: ' + eventId);
  return {
    eventId,
    standing,
    reason,
    rule,
    grounding: 'grounded',
    stored: true,
    receipt: false,
    event: stored,
  };
}

// The pending terminal (R10): a remote event whose prevs stay missing is
// stored rejected with grounding pending and a waits row per missing prev
// (old ruling B — "couldn't check yet" is not a verdict; a later arrival
// of the missing event re-runs it). ungroundedMs = 0 is the terminal
// drop: nothing is stored (Synapse's behaviour, chosen by the admin).
async function storePending(
  tx: RoomTx,
  pdu: Pdu,
  eventId: string,
  missing: string[],
  remote: RemoteIngest,
  redelivery: boolean,
): Promise<IngestLocalResult> {
  const canonical = canonicalJson(pdu as unknown as Record<string, unknown>);
  const row: EventRow = {
    id: eventId,
    pdu: canonical,
    type: String(pdu.type),
    state_key: pdu.state_key ?? null,
    sender: String(pdu.sender),
    depth: pdu.depth,
    origin_ts: pdu.origin_server_ts,
  };
  if (remote.ungroundedMs === 0) {
    return {
      eventId,
      standing: 'rejected',
      reason: null,
      rule: null,
      grounding: 'pending',
      stored: false,
      receipt: false,
      event: row,
    };
  }
  if (redelivery) {
    // still ungrounded on a redelivery — refresh the waiting set
    await tx.waits.removeOf(eventId);
  } else {
    await tx.events.insert(eventId, canonical);
    await tx.changes.append('event', eventId, {
      standing: 'rejected',
      reason: null,
      rule: null,
      type: row.type,
      state_key: row.state_key,
      sender: row.sender,
      depth: row.depth,
      origin_server_ts: row.origin_ts,
      stay: null,
      offset: null,
      grounding: 'pending',
      origin: remote.origin,
    });
  }
  await tx.events.setStatus(eventId, {
    standing: 'rejected',
    grounding: 'pending',
    origin: remote.origin,
    received_ts: Date.now(),
  });
  for (const m of missing) {
    await tx.waits.add({
      missing: m,
      waiting: eventId,
      kind: 'prev',
      since: Date.now(),
      expires: Date.now() + remote.ungroundedMs,
      state: 'pending',
    });
  }
  const stored = await tx.events.get(eventId);
  return {
    eventId,
    standing: 'rejected',
    reason: null,
    rule: null,
    grounding: 'pending',
    stored: true,
    receipt: false,
    event: stored === null ? row : stored,
  };
}

// The recheck driver (R10, old ruling B): waiting work is re-run when
// what it missed arrives — a pending event whose prevs all ground now is
// re-ingested (each in its own locked transaction, oldest first; an
// accepted one re-runs ITS waiters in turn) and a waiting redaction
// whose target is now held gets its effect evaluated. No fetching here
// (the network is the caller's layer); a still-ungrounded event keeps
// waiting, and a failure leaves the wait in place (logged, not fatal).
export async function resumeWaits(
  room: Room,
  deps: { self: string },
): Promise<number> {
  const processed = new Set<string>();
  let resumed = 0;
  for (;;) {
    const job = await room.tx(async (tx) => {
      for (const wait of await tx.waits.all()) {
        if (processed.has(wait.waiting + '|' + wait.kind)) continue;
        if (wait.kind === 'prev') {
          const status = await tx.events.getStatus(wait.waiting);
          if (status === null || status.grounding !== 'pending') {
            await tx.waits.remove(wait.missing, wait.waiting, wait.kind);
            continue;
          }
          const row = await tx.events.get(wait.waiting);
          if (row === null) {
            await tx.waits.remove(wait.missing, wait.waiting, wait.kind);
            continue;
          }
          const prevIds = (JSON.parse(row.pdu) as Pdu).prev_events ?? [];
          const missing = await ungroundedPrevs(tx, prevIds);
          if (missing.length > 0) continue;
          return { kind: 'prev' as const, eventId: wait.waiting };
        }
        if (wait.kind === 'redaction') {
          if ((await tx.events.get(wait.missing)) === null) continue;
          return {
            kind: 'redaction' as const,
            eventId: wait.waiting,
            target: wait.missing,
          };
        }
      }
      return null;
    });
    if (job === null) return resumed;
    processed.add(job.eventId + '|' + job.kind);
    try {
      if (job.kind === 'prev') {
        await withRoomLock(room.id, () =>
          room.tx(async (tx) => {
            const row = await tx.events.get(job.eventId);
            const status = await tx.events.getStatus(job.eventId);
            const stay = await tx.segments.openStay();
            if (row === null || status === null || stay === null) return;
            const version = await roomVersionOf(tx, stay.id);
            const pdu = JSON.parse(row.pdu) as Pdu;
            await ingestInTx(tx, room.id, pdu, {
              remote: {
                origin: status.origin ?? '',
                self: deps.self,
                // recomputed — the flag is a deterministic function of
                // the verified bytes and the version, never persisted
                oversized: oversizedOf(pdu, version),
                ungroundedMs: 0,
              },
            });
          }));
      } else {
        await withRoomLock(room.id, () =>
          room.tx(async (tx) => {
            const row = await tx.events.get(job.eventId);
            const target = await tx.events.get(job.target);
            if (row === null || target === null) return;
            const before = await tx.state.eventStateBefore(job.eventId);
            if (before === null) return;
            const stay = await tx.segments.openStay();
            if (stay === null) return;
            const version = await roomVersionOf(tx, stay.id);
            const pdu = JSON.parse(row.pdu) as Pdu;
            if (
              await redactionEffectAllowed(
                tx,
                getRulebook(version).spec,
                pdu,
                target,
                before.group,
              )
            ) {
              await tx.changes.append('redaction', job.eventId, {
                target: job.target,
              });
            }
            await tx.waits.remove(job.target, job.eventId, 'redaction');
          }));
      }
      resumed++;
    } catch (e) {
      console.error(`resumeWaits: ${job.kind} ${job.eventId} failed:`, e);
    }
  }
}

async function statePduOf(
  tx: RoomTx,
  group: number,
  type: string,
  stateKey: string,
): Promise<Pdu | null> {
  const id = await tx.state.groupKey(group, type, stateKey);
  if (id === null) return null;
  const row = await tx.events.get(id);
  return row === null ? null : (JSON.parse(row.pdu) as Pdu);
}

// The client-shaped redact operation (old redactEvent): the gate at the
// CURRENT state — one's own event needs the m.room.redaction event level;
// others' events — and unknown targets, where the own-event discount is
// unprovable — need the redact level as well. Distinct from the ingest
// effect check (G13): the op gate is the C-S contract the stage-5
// endpoint will expose; a rulebook reject maps to 403, never a 500.
export async function redactEvent(
  room: Room,
  sender: string,
  targetEventId: string,
  signer: Signer,
  reason?: string,
): Promise<{ eventId: string }> {
  const gate = await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) {
      throw new Error('E_ROOM_ARCHIVED: no open stay for ' + room.id);
    }
    const version = await roomVersionOf(tx, stay.id);
    const spec = getRulebook(version).spec;
    const group = await tx.state.current(stay.id);
    const plPdu = group === null
      ? null
      : await statePduOf(tx, group, 'm.room.power_levels', '');
    const createPdu = group === null
      ? null
      : await statePduOf(tx, group, 'm.room.create', '');
    const parsed = plPdu === null
      ? null
      : parsePowerLevels(plPdu.content, spec);
    const pl = parsed !== null && parsed.ok ? parsed.pl : null;
    const senderLevel = userPowerLevel(sender, plPdu, createPdu, spec);
    const target = await tx.events.get(targetEventId);
    const targetPdu = target === null ? null : (JSON.parse(target.pdu) as Pdu);
    const eventLevel = requiredLevel('m.room.redaction', undefined, pl);
    const required = targetPdu !== null && targetPdu.sender === sender
      ? eventLevel
      : Math.max(eventLevel, namedLevel('redact', pl));
    return { required, senderLevel, version };
  });
  if (gate.senderLevel < gate.required) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `redact requires level ${gate.required}, sender has ${gate.senderLevel}`,
    );
  }
  const content: Record<string, unknown> = {};
  const partial: BuildPartial = {
    type: 'm.room.redaction',
    sender,
    content,
    origin_server_ts: Date.now(),
  };
  if (getRulebook(gate.version).spec.redactsInContent) {
    content.redacts = targetEventId;
  } else {
    partial.redacts = targetEventId;
  }
  if (reason !== undefined) content.reason = reason;
  const res = await sendLocal(room, partial, signer);
  if (res.standing === 'rejected') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `redaction rejected (${res.reason}${
        res.rule === null ? '' : ', rule ' + res.rule
      })`,
    );
  }
  return { eventId: res.eventId };
}
