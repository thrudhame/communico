// api/engine/facade.ts — the msync engine interface over the gres room
// engine (the server side of the design §4.4 lite hat). One sync
// protocol, event-level floor (§4.2): the server's store engine is
// private implementation (§3.6); what crosses the boundary is canonical
// events with content-hash ids (§4.1.1).
//
// ingestRemote semantics (mirror of lite/web/engine-lite.js's):
//   verify content-hash id by recomputation (mismatch → {bad})
//   known via the in-memory eventIndex mirror → {known}
//   unknown prevs → held queue ({held}, drained after each apply)
//   apply via the core ingest pipeline; heals ride the existing
//   mergedriver (2-prev events). A KNOWN-but-consumed prev (a fork the
//   server already healed past on another branch) is re-materialized
//   with lite's MS0 route (branch at the prev's commit), then retried.
//
// Demo scale: the eventIndex mirror + events cache are in-memory
// (populated by an extremity-tip union at open, then kept current by
// ingestRemote applies and noteApplied from the core's applied signal).
// Table-backed reads are the durable-peer hardening item.
import { branchNameFor, ident, SERVER_DB, withDb } from './db.ts';
import { eventIdFor } from './eventid.ts';
import { ingestEvent } from './ingest.ts';
import { extremities as roomExtremities, lookupRoom } from './room.ts';
import type { Extremity } from './room.ts';

export interface RoomState {
  roomId: string;
  dbName: string;
  eventIndex: Set<string>; // mirror of event_index ids
  events: Map<string, Record<string, unknown>>; // id → canonical pdu
  held: Map<string, Record<string, unknown>>; // unknown-prev queue
  badEvents: number;
  merges: number;
}

export interface IngestRemoteResult {
  applied?: boolean;
  held?: boolean;
  known?: boolean;
  bad?: boolean;
}

export interface Facade {
  engineName: string;
  getRoom(): RoomState | null;
  extremities(room: RoomState): Promise<Extremity[]>;
  tableHashes(room: RoomState): Promise<{ events: string; state: string }>;
  ingestRemote(
    room: RoomState,
    pdu: Record<string, unknown>,
  ): Promise<IngestRemoteResult>;
  allEvents(room: RoomState): Promise<Record<string, unknown>[]>;
  hasEvent(room: RoomState, id: string): Promise<boolean>;
  eventCount(room: RoomState): Promise<number>;
  badEvents(room: RoomState): Promise<number>;
  merges(room: RoomState): Promise<number>;
  // Core applied-signal path (CS-hat sends): pull the stored pdu into the
  // mirror. Idempotent; no-op for ids the mirror already has.
  noteApplied(eventId: string): Promise<void>;
}

// Re-materialize consumed prev branches (lite MS0 route): the prev's
// commit is known (event_index), so re-point its D8 branch at it. The
// ingest pipeline's extremity check then passes and the event lands as
// a fork — exactly what a P2P peer's stale view should produce.
async function rematerializePrevs(
  st: RoomState,
  prevs: string[],
): Promise<void> {
  const rows = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1 AND event_id = ANY($2);',
      [st.roomId, prevs],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows as any[];
  });
  for (const row of rows) {
    const prevId = String(row.event_id);
    const branch = await branchNameFor(prevId);
    await withDb(st.dbName, async (c) => {
      await c.query(
        `SELECT DOLT_BRANCH('${ident(branch)}', '${ident(String(row.commit_hash))}');`,
      );
    });
    await withDb(SERVER_DB, async (c) => {
      await c.query(
        'UPDATE event_index SET branch_name = $1 WHERE room_id = $2 AND event_id = $3;',
        [branch, st.roomId, prevId],
      );
    });
  }
}

async function applyPdu(
  st: RoomState,
  pdu: Record<string, unknown>,
): Promise<'applied' | 'held'> {
  const id = String(pdu.event_id);
  const prevs = (pdu.prev_events ?? []) as string[];
  const incoming = {
    type: String(pdu.type),
    state_key: pdu.state_key == null ? undefined : String(pdu.state_key),
    sender: String(pdu.sender),
    content: pdu.content,
    prev_events: prevs,
    origin_ts: Number(pdu.origin_server_ts),
  };
  try {
    await ingestEvent(st.roomId, incoming);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('M_UNKNOWN_PREV')) {
      // mirror lag (an event the core knows but the mirror hasn't seen
      // yet is caught by the caller's prev check; this is the defensive
      // path — never propagate)
      st.held.set(id, pdu);
      return 'held';
    }
    if (msg.includes('M_PREV_NOT_EXTREMITY')) {
      await rematerializePrevs(st, prevs);
      try {
        await ingestEvent(st.roomId, incoming);
      } catch (e2) {
        if (String(e2).includes('M_UNKNOWN_PREV')) {
          st.held.set(id, pdu);
          return 'held';
        }
        throw e2;
      }
    } else {
      throw e;
    }
  }
  if (prevs.length === 2) st.merges++;
  st.eventIndex.add(id);
  st.events.set(id, pdu);
  st.held.delete(id);
  return 'applied';
}

async function ingestRemote(
  st: RoomState,
  pdu: Record<string, unknown>,
): Promise<IngestRemoteResult> {
  if (!pdu || typeof pdu.event_id !== 'string') {
    st.badEvents++;
    return { applied: false, bad: true };
  }
  // content-hash ids are self-certifying: verify by recomputation
  const expect = await eventIdFor(pdu);
  if (expect !== pdu.event_id) {
    st.badEvents++;
    return { applied: false, bad: true };
  }
  if (st.eventIndex.has(pdu.event_id)) return { applied: false, known: true };
  const prevs = (pdu.prev_events ?? []) as string[];
  if (prevs.some((p) => !st.eventIndex.has(p))) {
    st.held.set(pdu.event_id, pdu);
    return { applied: false, held: true };
  }
  const r = await applyPdu(st, pdu);
  if (r !== 'applied') return { applied: false, held: true };
  // drain the held queue: each apply may unblock more
  let progress = true;
  while (progress) {
    progress = false;
    for (const [, hpdu] of [...st.held]) {
      const hp = (hpdu.prev_events ?? []) as string[];
      if (hp.every((p) => st.eventIndex.has(p))) {
        const hr = await applyPdu(st, hpdu);
        if (hr === 'applied') progress = true;
      }
    }
  }
  return { applied: true };
}

async function openRoom(roomId: string): Promise<RoomState | null> {
  const room = await lookupRoom(roomId);
  if (!room) return null;
  const st: RoomState = {
    roomId,
    dbName: room.dbName,
    eventIndex: new Set(),
    events: new Map(),
    held: new Map(),
    badEvents: 0,
    merges: 0,
  };
  // union across alive extremity tips (same shape as lite's timeline
  // union; covers pre-fork history on both sides)
  const tips = await roomExtremities(room.dbName, roomId);
  await withDb(room.dbName, async (c) => {
    for (const t of tips) {
      const h = await c.query(
        `SELECT (SELECT HASHOF('${ident(t.branch)}')) AS h;`,
      );
      const hash = String(h.rows[0].h);
      const r = await c.query(
        `SELECT canonical_json FROM events AS OF '${hash}';`,
      );
      // deno-lint-ignore no-explicit-any
      for (const row of r.rows as any[]) {
        const pdu = row.canonical_json as Record<string, unknown>;
        const id = String(pdu.event_id);
        if (!st.eventIndex.has(id)) {
          st.eventIndex.add(id);
          st.events.set(id, pdu);
        }
      }
    }
  });
  return st;
}

function facadeFor(st: RoomState): Facade {
  return {
    engineName: 'doltgres',
    getRoom: () => st,
    extremities: (r) => roomExtremities(r.dbName, r.roomId),
    async tableHashes(r) {
      // advisory gossip — read at the newest extremity tip (fresh
      // connections land on main, which only holds genesis)
      return await withDb(r.dbName, async (c) => {
        const b = await c.query(
          `SELECT name FROM dolt.branches WHERE name LIKE 'x%'
           ORDER BY latest_commit_date DESC, name ASC LIMIT 1;`,
        );
        if (b.rows.length > 0) {
          await c.query(
            `SELECT DOLT_CHECKOUT('${ident(String(b.rows[0].name))}');`,
          );
        }
        const ev = await c.query(`SELECT dolt_hashof_table('events') AS h;`);
        const stH = await c.query(`SELECT dolt_hashof_table('state') AS h;`);
        return { events: String(ev.rows[0].h), state: String(stH.rows[0].h) };
      });
    },
    ingestRemote: (r, pdu) => ingestRemote(r, pdu),
    // deno-lint-ignore require-await
    async allEvents(r) {
      return [...r.events.values()];
    },
    // deno-lint-ignore require-await
    async hasEvent(r, id) {
      return r.eventIndex.has(id);
    },
    // deno-lint-ignore require-await
    async eventCount(r) {
      return r.eventIndex.size;
    },
    // deno-lint-ignore require-await
    async badEvents(r) {
      return r.badEvents;
    },
    // deno-lint-ignore require-await
    async merges(r) {
      return r.merges;
    },
    async noteApplied(eventId) {
      if (st.eventIndex.has(eventId)) return;
      const hash = await withDb(SERVER_DB, async (c) => {
        const r = await c.query(
          'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [st.roomId, eventId],
        );
        return r.rows.length ? String(r.rows[0].commit_hash) : null;
      });
      if (!hash) return;
      await withDb(st.dbName, async (c) => {
        const r = await c.query(
          `SELECT canonical_json FROM events AS OF '${ident(hash)}' WHERE event_id = $1;`,
          [eventId],
        );
        if (r.rows.length) {
          st.events.set(
            eventId,
            r.rows[0].canonical_json as Record<string, unknown>,
          );
          st.eventIndex.add(eventId);
        }
      });
    },
  };
}

// One facade (server peer state) per room, lazily opened.
const facades = new Map<string, Promise<Facade | null>>();

export function getFacadeFor(roomId: string): Promise<Facade | null> {
  let f = facades.get(roomId);
  if (!f) {
    f = (async () => {
      const st = await openRoom(roomId);
      return st ? facadeFor(st) : null;
    })();
    facades.set(roomId, f);
  }
  return f;
}
