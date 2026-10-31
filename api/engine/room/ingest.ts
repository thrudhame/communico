// api/engine/room/ingest.ts — local ingest (3b): one room transaction per
// event, under the per-room lock. The pipeline (requirements §4.1/§4.3,
// old ingest's locked steps): version gate and format guards, idempotent
// redelivery, prev grounding, state before (single-prev aliases the
// parent's after-group — never a resolution), auth chain / state / current
// (soft-fail) checks, standing, event + edges + status + event-state refs,
// extremities (accepted events consume their prevs, walking back through
// flagged ancestors), positions, the change log (event, publication via
// the event's change pos, membership change, delivery intent), and the
// current-state publication through materialize(). Rejected events are
// stored too (standing rejected), never published, never extremities (G11).
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
  loadRulebookStore,
  resolvePrevs,
  roomVersionOf,
  stateBefore,
} from '#engine/room/build.ts';
import type { EventRow, Room, RoomTx } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import {
  redactionEffectAllowed,
  redactionTarget,
} from '#engine/room/redaction.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { StateChange } from '#engine/room/state.ts';

export type Standing = 'accepted' | 'rejected' | 'soft_failed';

export type IngestLocalResult = {
  eventId: string;
  standing: Standing;
  reason: 'auth' | 'state' | null;
  rule: string | null;
  event: EventRow;
};

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function mapEntries(map: StateMap): StateChange[] {
  const out: StateChange[] = [];
  for (const [k, event] of map) {
    const sep = k.indexOf('\0');
    out.push({
      type: k.slice(0, sep),
      state_key: k.slice(sep + 1),
      event,
    });
  }
  return out;
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
  return await withRoomLock(room.id, () =>
    room.tx(async (tx) => {
      const pdu = await buildInTx(tx, room.id, partial, signer);
      return await ingestInTx(tx, room.id, pdu);
    }));
}

// Ingest an already-built local PDU: the per-room lock and the room
// transaction are acquired here (R13). Everything the event writes commits
// or rolls back together (G11).
export async function ingestLocal(
  room: Room,
  pdu: Pdu,
): Promise<IngestLocalResult> {
  return await withRoomLock(
    room.id,
    () => room.tx((tx) => ingestInTx(tx, room.id, pdu)),
  );
}

// The tx-scoped core: the caller holds the room lock and composes (the
// genesis stay creation, createRoom's sequence, rollback tests).
export async function ingestInTx(
  tx: RoomTx,
  roomId: string,
  pdu: Pdu,
): Promise<IngestLocalResult> {
  const isCreate = pdu.type === 'm.room.create' &&
    (pdu.prev_events ?? []).length === 0;
  const stay = await tx.segments.openStay();
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
  // no re-verification.
  const existing = await tx.events.get(eventId);
  if (existing !== null) {
    const status = await tx.events.getStatus(eventId);
    if (status === null) {
      throw new Error('E_STATUS_MISSING: ' + eventId);
    }
    return {
      eventId,
      standing: status.standing,
      reason: null,
      rule: null,
      event: existing,
    };
  }

  let hashOk = false;
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
  // verifies the id and content hash and requires a signature entry.
  // (Remote signature verification is 3c, G9.)
  const signatureServers = Object.keys(pdu.signatures ?? {});
  if (signatureServers.length === 0) {
    throw new Error('M_UNAUTHORIZED: PDU signature missing or invalid');
  }
  if (signatureServers.length !== 1) {
    throw new Error(
      'E_LOCAL_SIGNATURE: a local event carries exactly one signature server',
    );
  }
  const self = signatureServers[0];

  // Prev grounding and the local depth check (a mismatch is a stored
  // auth-reject, as in the old shared pipeline).
  const prevs = await resolvePrevs(tx, prevIds);
  const computedDepth = prevs.ids.length === 0
    ? 1
    : Math.max(...prevs.depths) + 1;
  const depthOk = pdu.depth === computedDepth;

  // The rulebook store: the bounded auth closure over the prevs' and the
  // current extremities' state ids plus the declared auth ids.
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
  const store = await loadRulebookStore(tx, [...seeds]);

  const before = await stateBefore(tx, prevs.afterGroups, rulebook, store);
  const priorGroup = await tx.state.current(stay.id);

  // The S8 sequence: auth chain (with the local declared-set determinism
  // check) -> state -> soft-fail against the current resolved state.
  let standing: Standing = 'accepted';
  let reason: 'auth' | 'state' | null = null;
  let rule: string | null = null;
  if (!hashOk || !depthOk) {
    standing = 'rejected';
    reason = 'auth';
  } else {
    const chain = rulebook.checkAuthChain(pdu, store);
    const selected = isCreate ? null : rulebook.selectAuthEvents(pdu, before);
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
        const current = await stateBefore(tx, extremityGroups, rulebook, store);
        if (!rulebook.checkAuthAgainstState(pdu, current, store).ok) {
          standing = 'soft_failed';
        }
      }
    }
  }

  // Event-state refs (R5): a single parent's before-ref aliases its
  // after-group; a resolved before-map lands as a fresh snapshot. The
  // after-map is the before-map plus the event's own key — for accepted
  // AND soft-failed state events (a soft-failed state event is in its own
  // after-state even though it is never published); rejected events get
  // the pass-through map.
  let beforeGroup: number;
  if (prevs.afterGroups.length === 0) {
    beforeGroup = await tx.materialize.newGroup(null, []);
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
  await tx.events.insert(
    eventId,
    canonicalJson(pdu as unknown as Record<string, unknown>),
  );
  await tx.events.setStatus(eventId, {
    standing,
    grounding: 'grounded',
    origin: null,
    received_ts: Date.now(),
  });
  await tx.materialize.setEventState(eventId, beforeGroup, afterGroup, 'dag');

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
  // order; rejected/soft-failed events are change-log entries only.
  const offset = standing === 'accepted'
    ? await tx.segments.appendPosition(stay.id, eventId)
    : null;
  const changePos = await tx.changes.append('event', eventId, {
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
  });

  // Publication (R6/R7): the live stay's current state is the single
  // extremity's after-group or the resolution over the new frontier —
  // published only when it changed.
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
      for (const id of newFrontier) {
        const after = await tx.state.eventStateAfter(id);
        if (after !== null) groups.push(after.group);
      }
      const resolved = await stateBefore(tx, groups, rulebook, store);
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

  // Delivery intent (R11): remote server names with joined members in the
  // state after the event, excluding this server.
  if (standing === 'accepted') {
    const afterMap = new Map(before);
    if (stateKey !== null) {
      afterMap.set(String(pdu.type) + '\0' + stateKey, eventId);
    }
    const destinations = new Set<string>();
    for (const [key, id] of afterMap) {
      if (!key.startsWith('m.room.member\0')) continue;
      const row = await tx.events.get(id);
      if (row === null || membershipOfPdu(row.pdu) !== 'join') continue;
      destinations.add(domainOf(key.slice('m.room.member\0'.length)));
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
  return { eventId, standing, reason, rule, event: stored };
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
