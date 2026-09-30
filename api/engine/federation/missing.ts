// api/engine/federation/missing.ts — the bounded fetch for unknown
// prevs (§3.4). Called by the transaction handler when ingest throws
// M_UNKNOWN_PREV for a pushed PDU (never for local authoring, never for
// 'before'/'evidence' batches — their frontier is expected to be
// unknown). The chain: brief wait (the sender usually pushes them next)
// → ONE get_missing_events → /state_ids + /event for the still-missing
// (tuwunel's shape) → the caller retries the pushed PDU once; a prev
// still unknown lands 'ungrounded' (D1, Dendrite; redelivery
// re-evaluates — ruling B). Lock discipline per §3.2: ALL of this runs
// with the room lock RELEASED — the handler re-takes it and re-checks
// before mutating (the prev may have arrived meanwhile — that is the
// point; otherwise the transaction carrying the missing prev queues
// behind the one waiting for it). One in-flight fetch chain per
// (room, prev) so a burst of PDUs citing the same prev does not
// multiply requests.
import { config } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import {
  ingestEvent,
  ingestPrevWithFetchedStateLocked,
  onEventApplied,
  storeUngroundedLocked,
  storeUnverifiableLocked,
  withRoomLock,
} from '#engine/ingest.ts';
import { extremities, groundingOf, lookupRoom } from '#engine/room.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { federationRequest } from './client.ts';
import type { StateRowInput } from '#engine/materialize.ts';
import type { Pdu } from '#engine/pdu.ts';

async function unknownPrevIds(
  roomId: string,
  prevIds: string[],
): Promise<string[]> {
  if (prevIds.length === 0) return [];
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT event_id FROM event_index WHERE room_id = $1 AND event_id = ANY($2);',
      [roomId, prevIds],
    );
    const known = new Set(
      // deno-lint-ignore no-explicit-any
      r.rows.map((row: any) => String(row.event_id)),
    );
    return prevIds.filter((id) => !known.has(id));
  });
}

// prevs that do not ground the pdu: truly unknown OR held as a
// placeholder/evidence (a placeholder is still missing from the timeline
// — get_missing_events fires for it too; the Complement BadJSON case's
// message3 cites a placeholder)
async function ungroundedPrevIds(
  roomId: string,
  prevIds: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of prevIds) {
    if ((await groundingOf(roomId, id)) !== 'own') out.push(id);
  }
  return out;
}

// one in-flight chain per (room, prev) — a burst of PDUs citing the
// same prev shares the one fetch
const inFlight = new Map<string, Promise<void>>();

export async function fetchMissingPrevs(
  roomId: string,
  pdu: Pdu,
  origin: string,
  budget: { until: number },
): Promise<void> {
  const prevIds = pdu.prev_events == null ? [] : pdu.prev_events;
  const missing = await ungroundedPrevIds(roomId, prevIds);
  if (missing.length === 0) return;
  const key = roomId + '|' + missing[0];
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    await existing;
    return;
  }
  const p = doFetch(roomId, pdu, origin, budget, missing);
  inFlight.set(key, p);
  try {
    await p;
  } finally {
    inFlight.delete(key);
  }
}

async function doFetch(
  roomId: string,
  pdu: Pdu,
  origin: string,
  budget: { until: number },
  missing: string[],
): Promise<void> {
  const fed = config().federation;
  const budgetLeft = () => budget.until - Date.now();

  // 1. WAIT missingwaitms, waking early if any of the missing ids arrive
  //    (tuwunel fetch_prev.rs:53-62) — the lock is NOT held meanwhile
  {
    const unlisten = onEventApplied((evRoom, eventId) => {
      void evRoom;
      if (missing.includes(eventId)) {
        missing.splice(missing.indexOf(eventId), 1);
      }
    });
    try {
      const deadline = Date.now() +
        Math.min(fed.missingwaitms, Math.max(0, budgetLeft()));
      while (Date.now() < deadline && missing.length > 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      unlisten();
    }
  }
  const still = await ungroundedPrevIds(
    roomId,
    pdu.prev_events == null ? [] : pdu.prev_events,
  );
  if (still.length === 0) return;

  // 2. ONE get_missing_events (backfill.yaml:71-141): earliest = our
  //    current forward extremities of the room, latest = the pushed PDU,
  //    limit = missinglimit, min_depth = 0. Answered events land 'after'
  //    in depth order (they are new to us and go to clients — Synapse
  //    _process_pulled_events with backfilled=False); an answered event
  //    that fails is dropped and its descendants stay ungrounded
  //    (TestOutboundFederationIgnoresMissingEventWithBadJSONForRoomVersion6).
  if (budgetLeft() > 0) {
    const room = await lookupRoom(roomId);
    if (room !== null) {
      const earliest = (await extremities(room.dbName, roomId)).map((e) =>
        e.eventId
      );
      try {
        const res = await federationRequest({
          destination: origin,
          method: 'POST',
          path: `/_matrix/federation/v1/get_missing_events/${
            encodeURIComponent(roomId)
          }`,
          body: new TextEncoder().encode(
            JSON.stringify({
              earliest_events: earliest,
              latest_events: [String(pdu.event_id)],
              limit: fed.missinglimit,
              min_depth: 0,
            }),
          ),
        });
        const ej = res.json as { events?: unknown[] } | null;
        const answered = (ej == null || ej.events == null ? [] : ej.events)
          .map((e) => e as Pdu);
        // the wire form has no event_id (v3+ — transported out-of-band);
        // compute it before ingest
        for (const ev of answered) {
          (ev as unknown as Record<string, unknown>).event_id =
            await eventIdFor(
              ev as unknown as Record<string, unknown>,
              room.roomVersion,
            );
        }
        answered.sort((a, b) => a.depth - b.depth);
        for (const ev of answered) {
          try {
            await ingestEvent(roomId, ev, {
              remote: { origin, position: 'after' },
            });
          } catch (e) {
            if (String(e).includes('M_UNKNOWN_PREV')) {
              // a pulled event whose own prevs are missing is not dropped
              // — it waits as a placeholder, and step 3 chases the gap
              // tip behind it (Synapse's pulled-event model); only
              // format/signature failures drop (…BadJSONForRoomVersion6)
              await withRoomLock(roomId, async () => {
                await storeUngroundedLocked(roomId, ev, origin);
              });
            }
            // else: dropped — its descendants stay ungrounded
          }
        }
      } catch {
        // the fetch failed outright — fall through to the terminal
      }
    }
  }
  // 3. /state_ids + /event for the GAP TIPS (at most missinglimit state
  //    fetches per pushed PDU, the whole chain inside the transaction's
  //    budget): a prev we HOLD as a placeholder is never /state_ids'd —
  //    the missing point behind it is (Synapse's pulled-event model;
  //    TestCorruptedAuthChain pins the far event, not the near one)
  const gapTips: string[] = [];
  const chased = new Set<string>();
  const chase = async (ids: string[]): Promise<void> => {
    for (const id of ids) {
      if (chased.has(id) || gapTips.length >= fed.missinglimit) continue;
      chased.add(id);
      const g = await groundingOf(roomId, id);
      if (g === 'own') continue;
      if (g === 'unknown') {
        gapTips.push(id);
      } else {
        await chase(await prevIdsOf(roomId, id));
      }
    }
  };
  await chase(pdu.prev_events == null ? [] : pdu.prev_events);
  for (const tip of gapTips) {
    if (budgetLeft() <= 0) return;
    await fetchPrevWithState(roomId, tip, origin, budget);
  }
}

// the event's own prev ids, read from its commit (a placeholder's chain
// is what the chase walks)
async function prevIdsOf(
  roomId: string,
  eventId: string,
): Promise<string[]> {
  const room = await lookupRoom(roomId);
  if (room === null) return [];
  const commit = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return r.rows.length === 0 ? null : String(r.rows[0].commit_hash);
  });
  if (commit === null) return [];
  return await withDb(room.dbName, async (c) => {
    const r = await c.query(
      `SELECT prev_events FROM events AS OF '${commit}' WHERE event_id = $1;`,
      [eventId],
    );
    if (r.rows.length === 0) return [];
    const raw = r.rows[0].prev_events;
    return Array.isArray(raw)
      ? raw.map(String)
      : (JSON.parse(String(raw)) as unknown[]).map(String);
  });
}

async function fetchPrevWithState(
  roomId: string,
  prevId: string,
  origin: string,
  budget: { until: number },
): Promise<void> {
  const fed = config().federation;
  const room = await lookupRoom(roomId);
  if (room === null) return;
  let pduIds: string[];
  let authChainIds: string[];
  try {
    const res = await federationRequest({
      destination: origin,
      method: 'GET',
      path: `/_matrix/federation/v1/state_ids/${
        encodeURIComponent(roomId)
      }?event_id=${encodeURIComponent(prevId)}`,
      body: null,
    });
    const j = res.json as { pdu_ids?: unknown[]; auth_chain_ids?: unknown[] };
    pduIds = (j.pdu_ids == null ? [] : j.pdu_ids).map(String);
    authChainIds = (j.auth_chain_ids == null ? [] : j.auth_chain_ids).map(
      String,
    );
  } catch {
    return; // the prev stays missing — the caller's terminal decides
  }
  const authChainSet = new Set(authChainIds);
  const wanted = [...new Set([...pduIds, ...authChainIds])];
  const unknown = await unknownPrevIds(roomId, wanted);
  const fetched: Pdu[] = [];
  let corruptedAuthChain = false;
  for (const id of unknown.slice(0, fed.missinglimit)) {
    if (budget.until - Date.now() <= 0) return;
    const ev = await fetchEvent(roomId, id, origin);
    if (ev === null) {
      if (authChainSet.has(id)) corruptedAuthChain = true;
      continue;
    }
    // 'evidence' — the reference resolves; never news
    fetched.push(ev);
  }
  const prev = await fetchEvent(roomId, prevId, origin);
  if (prev === null) return;
  if (corruptedAuthChain) {
    // events whose auth events could not be fetched must not become
    // accepted (TestCorruptedAuthChain): the prev is 'unverifiable'-
    // rejected and the pushed PDU ends 'ungrounded'
    await withRoomLock(roomId, async () => {
      await storeUnverifiableLocked(roomId, prev, origin);
    });
    return;
  }
  // the prev itself via /event, ingested 'after' with the fetched state
  // as its "before" state (the remote's state at the event — Synapse
  // federation_event.py:1188-1230). Rows come from the just-fetched
  // events AND events we already hold (the common case: create/PL).
  const fetchedState: StateRowInput[] = [];
  for (const id of pduIds) {
    let ev = fetched.find((e) => String(e.event_id) === id);
    if (ev === undefined) {
      const held = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [roomId, id],
        );
        return r.rows.length ? String(r.rows[0].commit_hash) : null;
      });
      if (held !== null) {
        const room2 = await lookupRoom(roomId);
        if (room2 !== null) {
          ev = (await withDb(room2.dbName, async (c) => {
            const r = await c.query(
              `SELECT canonical_json FROM events AS OF '${held}' WHERE event_id = $1;`,
              [id],
            );
            return r.rows.length
              ? (typeof r.rows[0].canonical_json === 'string'
                ? JSON.parse(String(r.rows[0].canonical_json))
                : r.rows[0].canonical_json) as Pdu
              : undefined;
          })) as Pdu | undefined;
        }
      }
    }
    if (ev === undefined || ev.state_key === undefined) continue;
    fetchedState.push({
      type: String(ev.type),
      stateKey: String(ev.state_key),
      eventId: id,
      content: ev.content == null ? {} : ev.content,
    });
  }
  await withRoomLock(roomId, async () => {
    await ingestPrevWithFetchedStateLocked(
      roomId,
      prev,
      fetched,
      fetchedState,
      origin,
    );
  });
}

async function fetchEvent(
  roomId: string,
  eventId: string,
  origin: string,
): Promise<Pdu | null> {
  try {
    const res = await federationRequest({
      destination: origin,
      method: 'GET',
      path: `/_matrix/federation/v1/event/${encodeURIComponent(eventId)}`,
      body: null,
    });
    const pj = res.json as { pdus?: unknown[] } | null;
    const pdus = (pj == null || pj.pdus == null ? [] : pj.pdus) as Pdu[];
    if (pdus.length === 0) return null;
    const pdu = pdus[0];
    const roomForVersion = await lookupRoom(roomId);
    (pdu as unknown as Record<string, unknown>).event_id = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      roomForVersion == null ? '11' : roomForVersion.roomVersion,
    );
    if (String(pdu.event_id) !== eventId) return null;
    return pdu;
  } catch {
    return null; // a 404 on the id — the caller decides what it means
  }
}
