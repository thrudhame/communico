// Recovery outliers are immutable evidence, not published room state. Like
// Synapse's outlier owner, authorize the complete graph then persist bounded
// batches. A changed room cut invalidates the prepared decisions, never an
// imported state prefix. The final caller still imports its whole boundary in
// one transaction after lifecycle/ACL/auth revalidation.
import { canonicalJson } from '#engine/canonical.ts';
import { withAuthProofs } from '#engine/auth-proofs.ts';
import type { Pdu } from '#engine/pdu.ts';
import { aclAllows } from '#engine/room/acl.ts';
import {
  checkDeclaredAuth,
  roomCreateId,
  roomVersionOf,
} from '#engine/room/build.ts';
import type { Room } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { orderEvents } from '#engine/room/order.ts';
import { getRulebook } from '#engine/rulebook/index.ts';

const BATCH = 32;

export async function stageRecoveryEvidence(
  room: Room,
  pack: Map<string, Pdu>,
  live: ReadonlySet<string>,
  origin: string,
  version: string,
): Promise<boolean> {
  // Evidence whose auth depends on a live candidate must follow that candidate's
  // real state-dependent verdict. Keep only a bounded tail in the live batch;
  // an excessive dependency cut leaves the whole recovery unresolved instead
  // of admitting a partial boundary or an unbounded locked write.
  const blocked = new Set(live);
  const ordered = orderEvents(
    [...pack].map(([eventId, pdu]) => ({ eventId, pdu })),
    ['auth_events'],
  );
  const eligible = new Map<string, Pdu>();
  for (const { eventId, pdu } of ordered) {
    if ((pdu.auth_events ?? []).some((id) => blocked.has(id))) {
      blocked.add(eventId);
    } else eligible.set(eventId, pdu);
  }
  if (pack.size - eligible.size > BATCH) return false;
  if (eligible.size === 0) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cut = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      if (
        stay === null || await roomVersionOf(tx, stay.id) !== version ||
        !await aclAllows(tx, origin)
      ) return null;
      return {
        head: await tx.changes.head(),
        createId: await roomCreateId(tx, stay.id),
      };
    });
    if (cut === null) return false;
    // Auth graph hydration also yields in bounded snapshots. All snapshots must
    // have the same change cut; never combine statuses from different revisions.
    const pdus = new Map<string, Pdu>(eligible);
    const known = new Set<string>();
    const heldRejected = new Set<string>();
    const seen = new Set<string>();
    const queue = [...eligible.keys()];
    if (cut.createId !== null) queue.push(cut.createId);
    const scheduled = new Set(queue);
    let staleRead = false;
    for (let start = 0; start < queue.length;) {
      const chunk = queue.slice(start, start + BATCH);
      start += chunk.length;
      const ids = chunk.filter((id) => !seen.has(id));
      for (const id of ids) seen.add(id);
      if (seen.size > 100_000) {
        throw new Error('E_AUTH_CLOSURE: auth closure exceeds 100000 events');
      }
      const read = await room.tx(async (tx) => {
        if (await tx.changes.head() !== cut.head) return null;
        return {
          rows: await tx.events.list(ids),
          statuses: await tx.events.statuses(ids),
        };
      });
      if (read === null) {
        staleRead = true;
        break;
      }
      for (const id of ids) {
        const row = read.rows.get(id);
        if (row !== undefined) pdus.set(id, JSON.parse(row.pdu) as Pdu);
        const status = read.statuses.get(id);
        if (status !== undefined) known.add(id);
        if (status?.standing === 'rejected') heldRejected.add(id);
        for (const auth of pdus.get(id)?.auth_events ?? []) {
          if (!scheduled.has(auth)) {
            scheduled.add(auth);
            queue.push(auth);
          }
        }
      }
    }
    if (staleRead) continue;
    const rejected = new Set(
      [...eligible.keys()].filter((id) => !known.has(id)),
    );
    const store = await withAuthProofs({
      get: (id) => pdus.get(id),
      isRejected: (id) => rejected.has(id) || heldRejected.has(id),
    }, pdus.values());
    const rulebook = getRulebook(version);
    const writes: {
      id: string;
      pdu: Pdu;
      auth: ReturnType<typeof checkDeclaredAuth>;
    }[] = [];
    for (const [id, pdu] of eligible) {
      if (known.has(id)) continue;
      rejected.delete(id);
      const auth = checkDeclaredAuth(pdu, rulebook, store, cut.createId);
      if (!auth.ok) rejected.add(id);
      writes.push({ id, pdu, auth });
      if (writes.length % BATCH === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    let head = cut.head;
    let stale = false;
    for (let start = 0; start < writes.length; start += BATCH) {
      const next = await withRoomLock(room.id, () =>
        room.tx(async (tx) => {
          if (await tx.changes.head() !== head) return null;
          const stay = await tx.segments.openStay();
          if (
            stay === null || await roomVersionOf(tx, stay.id) !== version ||
            !await aclAllows(tx, origin)
          ) return null;
          for (const { id, pdu, auth } of writes.slice(start, start + BATCH)) {
            if (await tx.events.get(id) !== null) continue;
            const standing = auth.ok ? 'accepted' : 'rejected';
            await tx.events.insert(
              id,
              canonicalJson(pdu as unknown as Record<string, unknown>),
            );
            await tx.events.setStatus(id, {
              standing,
              grounding: 'evidence',
              origin,
              received_ts: Date.now(),
            });
            await tx.changes.append('event', id, {
              standing,
              reason: auth.ok ? null : 'auth',
              rule: auth.ok ? null : auth.rule,
              type: pdu.type,
              state_key: pdu.state_key ?? null,
              sender: pdu.sender,
              depth: pdu.depth,
              origin_server_ts: pdu.origin_server_ts,
              stay: null,
              offset: null,
              grounding: 'evidence',
              origin,
            });
          }
          return await tx.changes.head();
        }));
      if (next === null) {
        stale = true;
        break;
      }
      head = next;
    }
    if (stale) continue;
    for (const id of eligible.keys()) pack.delete(id);
    return true;
  }
  return false;
}
