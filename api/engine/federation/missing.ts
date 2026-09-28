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
  storeUnverifiableLocked,
  withRoomLock,
} from '#engine/ingest.ts';
import { extremities, lookupRoom } from '#engine/room.ts';
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

// one in-flight chain per (room, prev) — a burst of PDUs citing the
// same prev shares the one fetch
const inFlight = new Map<string, Promise<void>>();

export async function fetchMissingPrevs(
  roomId: string,
  pdu: Pdu,
  origin: string,
  budget: { until: number },
): Promise<void> {
  const prevIds = pdu.prev_events ?? [];
  const missing = await unknownPrevIds(roomId, prevIds);
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
  let still = await unknownPrevIds(roomId, pdu.prev_events ?? []);
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
        const answered = ((res.json as { events?: unknown[] })?.events ?? [])
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
          } catch {
            // dropped — its descendants stay ungrounded
          }
        }
      } catch {
        // the fetch failed outright — fall through to the terminal
      }
    }
  }
  still = await unknownPrevIds(roomId, pdu.prev_events ?? []);
  if (still.length === 0) return;

  // 3. /state_ids + /event for the still-missing prevs (at most
  //    missinglimit state fetches per pushed PDU, the whole chain inside
  //    the transaction's budget)
  for (const prevId of still) {
    if (budgetLeft() <= 0) return;
    await fetchPrevWithState(roomId, prevId, origin, budget);
  }
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
    pduIds = (j.pdu_ids ?? []).map(String);
    authChainIds = (j.auth_chain_ids ?? []).map(String);
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
      content: ev.content ?? {},
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
    const pdus = ((res.json as { pdus?: unknown[] })?.pdus ?? []) as Pdu[];
    if (pdus.length === 0) return null;
    const pdu = pdus[0];
    (pdu as unknown as Record<string, unknown>).event_id = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      (await lookupRoom(roomId))?.roomVersion ?? '11',
    );
    if (String(pdu.event_id) !== eventId) return null;
    return pdu;
  } catch {
    return null; // a 404 on the id — the caller decides what it means
  }
}
