// Resident serving on the room core. State uses the event's own before-ref,
// including imported boundaries; absent provenance never means current state.
import { config } from '#engine/config.ts';
import { backfillArguments, missingEventsRequest } from './history-request.ts';
import { redact } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room, RoomTx } from '#engine/room/index.ts';
import { erasedView } from '#engine/erasure.ts';
import { assertAcl } from '#engine/room/acl.ts';
import type { Standing } from '#engine/room/events.ts';
import { authChain } from '#engine/rulebook/state-res-v2.ts';
import { roomOf } from '#engine/server/read.ts';
import type { Database as Db } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { toWire } from './pdu.ts';
import { findTimestamp, type TimestampQuery } from '#engine/room/timestamp.ts';
import {
  authClosure,
  currentSnapshot,
  heldRoom,
  pduAt,
  serverInState,
} from './room.ts';

export type ServeDeps = {
  store: Store;
  server: Db;
  self: string;
  requireScope?(scope: string): Promise<void>;
};

async function readyRoom(deps: ServeDeps, roomId: string) {
  await deps.requireScope?.('room:' + roomId);
  return await heldRoom(deps.store, roomId);
}

async function inRoom(tx: RoomTx, origin: string) {
  await assertAcl(tx, origin);
  const snapshot = await currentSnapshot(tx);
  if (!(await serverInState(tx, snapshot.state, origin))) {
    throw new MatrixError(403, 'M_FORBIDDEN', `${origin} is not in the room`);
  }
  return snapshot.version;
}

async function stateBefore(tx: RoomTx, eventId: string) {
  if (await pduAt(tx, eventId) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  }
  const ref = await tx.state.eventStateBefore(eventId);
  if (ref === null) {
    // Synapse get_state_ids_for_pdu: outlier -> NotFoundError; tuwunel
    // state/state_ids: absent pdu_shortstatehash -> Request(NotFound).
    throw new MatrixError(
      404,
      'M_NOT_FOUND',
      'State not known at event ' + eventId,
    );
  }
  // dag and imported refs are both genuine snapshots (R5); none is not.
  const state = await tx.state.groupMap(ref.group);
  for (const id of state.values()) {
    if (await pduAt(tx, id) === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', id);
    }
  }
  return state;
}

async function chainAt(tx: RoomTx, ids: string[]) {
  const closure = await authClosure(tx, ids);
  const chain = authChain(ids, {
    get: (id) => closure.pdus.get(id),
    isRejected: () => false,
  });
  const events: Pdu[] = [];
  for (const id of chain) {
    const pdu = await pduAt(tx, id);
    if (pdu !== null) events.push(pdu);
  }
  return events;
}

async function serverCanSeeAt(
  tx: RoomTx,
  eventId: string,
  origin: string,
): Promise<boolean> {
  const ref = await tx.state.eventStateBefore(eventId);
  let full = false;
  if (ref !== null) {
    const before = await tx.state.groupMap(ref.group);
    const visId = before.get('m.room.history_visibility\0');
    const vis = visId === undefined ? null : await pduAt(tx, visId);
    const value = vis?.content?.history_visibility;
    const visibility = typeof value === 'string' ? value : 'shared';
    full = visibility === 'shared' || visibility === 'world_readable' ||
      ((visibility === 'joined' || visibility === 'invited') &&
        await serverInState(tx, before, origin, visibility === 'invited'));
  }
  return full;
}

async function wireVisible(
  tx: RoomTx,
  eventId: string,
  pdu: Pdu,
  version: string,
  origin: string,
  room: Room,
) {
  const visible = await serverCanSeeAt(tx, eventId, origin)
    ? await erasedView(
      room,
      eventId,
      pdu,
      version,
      { server: origin },
      undefined,
      tx,
    )
    : redact(
      pdu as unknown as Record<string, unknown>,
      version,
    ) as unknown as Pdu;
  return toWire(visible, version);
}

export async function serveTimestamp(
  roomId: string,
  query: TimestampQuery,
  origin: string,
  deps: ServeDeps,
) {
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    await inRoom(tx, origin);
    const hit = await findTimestamp(
      tx,
      query,
      (id) => serverCanSeeAt(tx, id, origin),
    );
    if (hit === null) {
      throw new MatrixError(
        404,
        'M_NOT_FOUND',
        'no visible event at timestamp',
      );
    }
    return hit;
  });
}

export async function serveStateIds(
  roomId: string,
  eventId: string,
  origin: string,
  deps: ServeDeps,
) {
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    await inRoom(tx, origin);
    const ids = [...(await stateBefore(tx, eventId)).values()];
    return {
      pdu_ids: ids,
      auth_chain_ids: (await chainAt(tx, ids)).map((p) => String(p.event_id)),
    };
  });
}

export async function serveState(
  roomId: string,
  eventId: string,
  origin: string,
  deps: ServeDeps,
) {
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    const version = await inRoom(tx, origin);
    const ids = [...(await stateBefore(tx, eventId)).values()];
    const pdus: Pdu[] = [];
    for (const id of ids) {
      const pdu = await pduAt(tx, id);
      if (pdu === null) throw new MatrixError(404, 'M_NOT_FOUND', id);
      pdus.push(pdu);
    }
    return {
      pdus: await Promise.all(
        pdus.map(async (p) =>
          toWire(
            await erasedView(
              room,
              String(p.event_id),
              p,
              version,
              { server: origin },
              undefined,
              tx,
            ),
            version,
          )
        ),
      ),
      auth_chain: await Promise.all(
        (await chainAt(tx, ids)).map(async (p) =>
          toWire(
            await erasedView(
              room,
              String(p.event_id),
              p,
              version,
              { server: origin },
              undefined,
              tx,
            ),
            version,
          )
        ),
      ),
    };
  });
}

export async function serveEvent(
  eventId: string,
  origin: string,
  deps: ServeDeps,
) {
  const roomId = await roomOf(deps.server, eventId);
  if (roomId === null) {
    await deps.requireScope?.('rooms');
    throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  }
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    const version = await inRoom(tx, origin);
    const pdu = await pduAt(tx, eventId);
    if (pdu === null) throw new MatrixError(404, 'M_NOT_FOUND', eventId);
    return {
      origin: deps.self,
      origin_server_ts: Date.now(),
      pdus: [await wireVisible(tx, eventId, pdu, version, origin, room)],
    };
  });
}

export async function serveEventAuth(
  roomId: string,
  eventId: string,
  origin: string,
  deps: ServeDeps,
) {
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    const version = await inRoom(tx, origin);
    if (await pduAt(tx, eventId) === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', eventId);
    }
    return {
      auth_chain: await Promise.all(
        (await chainAt(tx, [eventId])).map(async (p) =>
          toWire(
            await erasedView(
              room,
              String(p.event_id),
              p,
              version,
              { server: origin },
              undefined,
              tx,
            ),
            version,
          )
        ),
      ),
    };
  });
}

// Federation history follows the DAG across stay/history segments, not the
// publication sequence. Flagged ancestors have no timeline position but are
// still needed to ground a returned child. Soft-failed roots alone are not
// returned (SS Soft failure); a referencing root makes them eligible.
async function historySelection(
  tx: RoomTx,
  roots: string[],
  stops: string[],
  cap: number,
  includeRoots: boolean,
  minimumDepth = 0,
): Promise<Map<string, Pdu>> {
  if (!includeRoots) {
    const walk = await tx.events.missingCandidates(
      roots,
      stops,
      minimumDepth,
      cap,
    );
    if (walk.truncated) {
      throw new MatrixError(503, 'M_UNKNOWN', 'history walk exceeds bound');
    }
    const rows = await tx.events.list(walk.ids);
    return new Map(
      walk.ids.map((id) => [id, JSON.parse(rows.get(id)!.pdu) as Pdu]),
    );
  }
  const stop = new Set(stops);
  const excluded = new Set(includeRoots ? [] : roots);
  const held = new Map<
    string,
    { pdu: Pdu | null; standing: Standing | null }
  >();
  const expanded = new Set<string>();
  const found = new Map<string, Pdu>();
  let frontier = roots.map((id) => ({ id, referenced: false }));
  while (frontier.length > 0 && found.size < cap) {
    const next: typeof frontier = [];
    for (const { id, referenced } of frontier) {
      if (found.size >= cap) break;
      // doltgres seeds missing-events from every latest event's prevs even
      // when the same id is also earliest. Boundaries still never emit.
      if (stop.has(id) && (includeRoots || referenced)) continue;
      let entry = held.get(id);
      if (entry === undefined) {
        if (held.size >= 100_000) {
          throw new MatrixError(503, 'M_UNKNOWN', 'history walk exceeds bound');
        }
        const status = await tx.events.getStatus(id);
        entry = {
          pdu: await pduAt(tx, id),
          standing: status === null ? null : status.standing,
        };
        held.set(id, entry);
      }
      if (entry.pdu === null) continue;
      if (
        !excluded.has(id) && (entry.standing !== 'soft_failed' || referenced) &&
        entry.pdu.depth >= minimumDepth
      ) {
        found.set(id, entry.pdu);
      }
      if (expanded.has(id)) continue;
      expanded.add(id);
      for (const prev of await tx.events.prevsOf(id)) {
        next.push({ id: prev, referenced: true });
      }
    }
    frontier = next;
  }
  return found;
}

export async function serveBackfill(
  roomId: string,
  v: string[],
  limit: number | undefined,
  origin: string,
  deps: ServeDeps,
) {
  const request = backfillArguments(v, limit);
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    const version = await inRoom(tx, origin);
    const cap = Math.min(request.limit, config().federation.backfillmax);
    const out: Record<string, unknown>[] = [];
    for (
      const [id, pdu] of await historySelection(tx, request.v, [], cap, true)
    ) {
      out.push(await wireVisible(tx, id, pdu, version, origin, room));
    }
    return { origin: deps.self, origin_server_ts: Date.now(), pdus: out };
  });
}

export async function serveGetMissingEvents(
  roomId: string,
  body: Record<string, unknown>,
  origin: string,
  deps: ServeDeps,
) {
  const request = missingEventsRequest(body);
  const room = await readyRoom(deps, roomId);
  return await room.tx(async (tx) => {
    const version = await inRoom(tx, origin);
    const cap = Math.min(request.limit, config().federation.missingmax);
    const found = await historySelection(
      tx,
      request.latest,
      request.earliest,
      cap,
      false,
      request.minDepth,
    );
    const events: Record<string, unknown>[] = [];
    // Parent-before-child even when a remote event's declared depth is not
    // topological. Stable ids break ties, eliminating insertion-order output.
    const emitted = new Set<string>();
    while (emitted.size < found.size) {
      const ready: string[] = [];
      for (const [id] of found) {
        if (emitted.has(id)) continue;
        const parents = await tx.events.prevsOf(id);
        if (parents.every((p) => !found.has(p) || emitted.has(p))) {
          ready.push(id);
        }
      }
      if (ready.length === 0) {
        throw new MatrixError(503, 'M_UNKNOWN', 'cyclic history');
      }
      ready.sort();
      for (const id of ready) {
        emitted.add(id);
        events.push(
          await wireVisible(tx, id, found.get(id)!, version, origin, room),
        );
      }
    }
    return { events };
  });
}
