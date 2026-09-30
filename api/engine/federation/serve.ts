// api/engine/federation/serve.ts — serving state and history (§3.7).
// Every route checks serverInRoom(roomId, origin) first (Synapse
// assert_host_in_room on every one of these, event_auth.py:170-198;
// events.yaml:143-155 names the 403 for /state_ids) — 403 otherwise. The
// ACL hook point for M5c rides in each handler (aclCheck, no-op).
//
// Server visibility (visibleToServer): the spec has no server-side
// history-visibility text at v1.16 (recorded as a gap); the industry
// rule (Synapse visibility.py:669-754, tuwunel server_can.rs:23-66) and
// Complement's pin (TestInboundCanReturnMissingEvents:429-444: pre-join
// message served REDACTED to a 'joined'/'invited'-visibility room) is:
// history visibility at the state BEFORE the event — world_readable /
// shared → served; invited → served iff some member of the requesting
// server had membership invite or join in that state; joined → iff some
// member was join; otherwise served as the REDACTED copy, never omitted.
// Applies to /event, /backfill, /get_missing_events — NOT to /state,
// /state_ids, /event_auth (state is what the joiner is entitled to).
import { config, serverName } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { redact } from '#engine/eventid.ts';
import { stateKeyOf } from '#engine/policy.ts';
import { authChain } from '#engine/rulebook/state-res-v2.ts';
import { lookupRoom, serverInRoom, stateBefore } from '#engine/room.ts';
import { toWire } from './pdu.ts';
import type { Pdu } from '#engine/pdu.ts';

// The M5c hook point (SS:1236-1279): server ACLs check the origin
// against the room's m.room.server_acl here — a no-op in M5b.
function aclCheck(roomId: string, origin: string): void {
  void roomId;
  void origin;
}

async function assertInRoom(roomId: string, origin: string): Promise<void> {
  if (!(await serverInRoom(roomId, origin))) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `${origin} is not in ${roomId}`,
    );
  }
}

async function roomOf(eventId: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id FROM event_index WHERE event_id = $1;',
      [eventId],
    );
    return r.rows.length === 0 ? null : String(r.rows[0].room_id);
  });
}

async function commitOf(
  roomId: string,
  eventId: string,
): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return r.rows.length === 0 ? null : String(r.rows[0].commit_hash);
  });
}

async function pduAt(
  roomId: string,
  eventId: string,
): Promise<Pdu | null> {
  const room = await lookupRoom(roomId);
  if (room === null) return null;
  const commit = await commitOf(roomId, eventId);
  if (commit === null) return null;
  return await withDb(room.dbName, async (c) => {
    const r = await c.query(
      `SELECT canonical_json FROM events AS OF '${commit}' WHERE event_id = $1;`,
      [eventId],
    );
    if (r.rows.length === 0) return null;
    return (typeof r.rows[0].canonical_json === 'string'
      ? JSON.parse(String(r.rows[0].canonical_json))
      : r.rows[0].canonical_json) as Pdu;
  });
}

// Load the full auth closure of the seeds: authChain's store is
// synchronous, so the recursion must find every event already loaded —
// with only the seeds in the store the walk stops at depth 1 (the
// Complement event_auth cases: 4 events where the chain is 6, 3 where
// it is >100)
export async function loadAuthClosure(
  roomId: string,
  seedIds: string[],
): Promise<Map<string, Pdu>> {
  const pduById = new Map<string, Pdu>();
  let frontier = [...seedIds];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (pduById.has(id)) continue;
      const pdu = await pduAt(roomId, id);
      if (pdu === null) continue;
      pduById.set(id, pdu);
      for (const a of pdu.auth_events == null ? [] : pdu.auth_events) {
        if (!pduById.has(a)) next.push(a);
      }
    }
    frontier = next;
  }
  return pduById;
}

// visibleToServer per the header: 'full' | 'redacted'
async function visibleToServer(
  roomId: string,
  origin: string,
  eventId: string,
): Promise<'full' | 'redacted'> {
  const before = await stateBefore(roomId, eventId);
  const visId = before.get(stateKeyOf('m.room.history_visibility', ''));
  let visibility = 'shared';
  if (visId !== undefined) {
    const vis = await pduAt(roomId, visId);
    const v = (vis == null || vis.content == null ? {} : vis.content) as {
      history_visibility?: unknown;
    };
    if (typeof v.history_visibility === 'string') {
      visibility = v.history_visibility;
    }
  }
  if (visibility === 'world_readable' || visibility === 'shared') return 'full';
  // invited / joined: some member of the REQUESTING server had the right
  // membership in the state before the event
  for (const [k, eid] of before) {
    if (!k.startsWith('m.room.member')) continue;
    const mxid = k.slice('m.room.member'.length + 1);
    if (!mxid.endsWith(':' + origin)) continue;
    const m = await pduAt(roomId, eid);
    const membership = ((m == null || m.content == null ? {} : m.content) as {
      membership?: unknown;
    }).membership;
    if (visibility === 'invited') {
      if (membership === 'invite' || membership === 'join') return 'full';
    } else if (visibility === 'joined') {
      if (membership === 'join') return 'full';
    }
  }
  return 'redacted';
}

async function wireVisible(
  roomId: string,
  origin: string,
  pdu: Pdu,
  roomVersion: string,
): Promise<Record<string, unknown>> {
  const eventId = String(pdu.event_id);
  if ((await visibleToServer(roomId, origin, eventId)) === 'full') {
    return toWire(pdu, roomVersion);
  }
  return toWire(
    redact(
      pdu as unknown as Record<string, unknown>,
      roomVersion,
    ) as unknown as Pdu,
    roomVersion,
  );
}

// GET /v1/state/#roomId?event_id= (events.yaml:19-87)
export async function serveState(
  roomId: string,
  eventId: string,
  origin: string,
): Promise<Record<string, unknown>> {
  aclCheck(roomId, origin);
  await assertInRoom(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  const before = await stateBefore(roomId, eventId);
  const ids = [...before.values()];
  const pduById = await loadAuthClosure(roomId, ids);
  const store = {
    get: (id: string) => pduById.get(id),
    isRejected: () => false,
  };
  const chain = authChain(ids, store);
  return {
    pdus: ids
      .map((id) => pduById.get(id))
      .filter((p): p is Pdu => p !== undefined)
      .map((p) => toWire(p, room.roomVersion)),
    auth_chain: [...chain]
      .map((id) => pduById.get(id))
      .filter((p): p is Pdu => p !== undefined)
      .map((p) => toWire(p, room.roomVersion)),
  };
}

// GET /v1/state_ids/#roomId?event_id= (events.yaml:88-169); unknown
// event → 404 M_NOT_FOUND
export async function serveStateIds(
  roomId: string,
  eventId: string,
  origin: string,
): Promise<Record<string, unknown>> {
  aclCheck(roomId, origin);
  await assertInRoom(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  if ((await commitOf(roomId, eventId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  }
  const before = await stateBefore(roomId, eventId);
  const ids = [...before.values()];
  const pduById = await loadAuthClosure(roomId, ids);
  const store = {
    get: (id: string) => pduById.get(id),
    isRejected: () => false,
  };
  return {
    pdu_ids: ids,
    auth_chain_ids: [...authChain(ids, store)],
  };
}

// GET /v1/event/#eventId (events.yaml:170-191;
// single_pdu_transaction.yaml:14-32). Soft-failed events ARE served
// (SS:632-636); rejected events are served too (spec-silent; industry
// practice because auth chains reference them — Synapse
// federation.py:1464-1466). Filtered by server visibility.
export async function serveEvent(
  eventId: string,
  origin: string,
): Promise<Record<string, unknown>> {
  const roomId = await roomOf(eventId);
  if (roomId === null) throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  aclCheck(roomId, origin);
  await assertInRoom(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  const pdu = await pduAt(roomId, eventId);
  if (pdu === null) throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  return {
    origin: serverName(),
    origin_server_ts: Date.now(),
    pdus: [await wireVisible(roomId, origin, pdu, room.roomVersion)],
  };
}

// GET /v1/event_auth/#roomId/#eventId (event_auth.yaml:19-63): exactly
// the recursive auth chain, nothing else (TestEventAuth:96-112)
export async function serveEventAuth(
  roomId: string,
  eventId: string,
  origin: string,
): Promise<Record<string, unknown>> {
  aclCheck(roomId, origin);
  await assertInRoom(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  const pdu = await pduAt(roomId, eventId);
  if (pdu === null) throw new MatrixError(404, 'M_NOT_FOUND', eventId);
  const pduById = await loadAuthClosure(roomId, [eventId]);
  pduById.set(eventId, pdu);
  const store = {
    get: (id: string) => pduById.get(id),
    isRejected: () => false,
  };
  const chain = authChain([eventId], store);
  const out: Pdu[] = [];
  for (const id of chain) {
    const p = pduById.get(id);
    if (p !== undefined) out.push(p);
  }
  return {
    auth_chain: out.map((p) => toWire(p, room.roomVersion)),
  };
}

// GET /v1/backfill/#roomId?v=&limit= (backfill.yaml:19-70): limit
// required (400) and capped at backfillmax; walk prev_events back from
// each v (breadth-first over what we hold, live and history), INCLUDING
// v; order newest-first; the transaction shape; the visibility filter
export async function serveBackfill(
  roomId: string,
  v: string[],
  limit: number | undefined,
  origin: string,
): Promise<Record<string, unknown>> {
  aclCheck(roomId, origin);
  await assertInRoom(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  if (limit === undefined) {
    throw new MatrixError(400, 'M_BAD_JSON', 'limit is required');
  }
  const cap = Math.min(limit, config().federation.backfillmax);
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let frontier = [...v];
  while (frontier.length > 0 && out.length < cap) {
    const next: string[] = [];
    for (const id of frontier) {
      if (out.length >= cap) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const pdu = await pduAt(roomId, id);
      if (pdu === null) continue;
      out.push(await wireVisible(roomId, origin, pdu, room.roomVersion));
      next.push(...(pdu.prev_events == null ? [] : pdu.prev_events));
    }
    frontier = next;
  }
  return {
    origin: serverName(),
    origin_server_ts: Date.now(),
    pdus: out,
  };
}

// POST /v1/get_missing_events/#roomId (backfill.yaml:71-141): limit
// default 10, capped at missingmax; min_depth accepted and ignored
// (Synapse and tuwunel both ignore it — industry behaviour); breadth-
// first walk back from latest_events, stopping at earliest_events and at
// events we do not hold; result in FORWARD topological order; the
// visibility filter
export async function serveGetMissingEvents(
  roomId: string,
  body: {
    earliest_events?: unknown;
    latest_events?: unknown;
    limit?: unknown;
    min_depth?: unknown;
  },
  origin: string,
): Promise<Record<string, unknown>> {
  aclCheck(roomId, origin);
  await assertInRoom(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  const cap = Math.min(
    typeof body.limit === 'number' ? body.limit : 10,
    config().federation.missingmax,
  );
  const earliest = new Set(
    (Array.isArray(body.earliest_events) ? body.earliest_events : []).map(
      String,
    ),
  );
  const latest = (Array.isArray(body.latest_events) ? body.latest_events : [])
    .map(String);
  const out: { pdu: Pdu; depth: number }[] = [];
  const seen = new Set<string>();
  let frontier = [...latest];
  while (frontier.length > 0 && out.length < cap) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      // the earliest_events are the boundary the requester already HAS —
      // excluded from the answer, and the walk stops at them
      // (TestInboundCanReturnMissingEvents: the first answer event is the
      // creator's join, never the create)
      if (earliest.has(id)) continue;
      const pdu = await pduAt(roomId, id);
      if (pdu === null) continue; // an event we do not hold — the walk stops
      out.push({ pdu, depth: Number(pdu.depth == null ? 0 : pdu.depth) });
      next.push(...(pdu.prev_events == null ? [] : pdu.prev_events));
    }
    frontier = next;
  }
  // forward topological order (TestInboundCanReturnMissingEvents:420-473)
  out.sort((a, b) => a.depth - b.depth);
  const events: Record<string, unknown>[] = [];
  for (const { pdu } of out) {
    events.push(await wireVisible(roomId, origin, pdu, room.roomVersion));
  }
  return { events };
}
