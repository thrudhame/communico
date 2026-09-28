// api/engine/federation/transactions.ts — inbound transactions (§3.3):
// PUT /_matrix/federation/v1/send/{txnId}. Decide first, then answer
// (design point D): every PDU goes through the same ingest pipeline as a
// local event, in transaction order under the room lock, and the 200's
// `pdus` carries the real outcome for every PDU that had a computable id
// (transactions.yaml:61-91; a {} entry means "successfully handled" —
// rejection is not a transaction error, SS:565-566). The replay cache
// (federation_txns) gives a retried transaction the same answer; rows
// older than txnhours are pruned on insert — a cache, not an obligation.
//
// Body size: pathfinder's Body has NO default cap (its #limit is null
// unless a route's meta sets bodyLimit), so there is nothing to raise
// for /send's legitimate 50 PDUs × 65536 bytes (SS:423-424,
// CS:2869-2871) — checked 2026-09-28.
import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { eventIdFor } from '#engine/eventid.ts';
import {
  ingestEventLocked,
  ingestPrechecks,
  storeUngroundedLocked,
  withRoomLock,
} from '#engine/ingest.ts';
import { lookupRoom, serversInRoom } from '#engine/room.ts';
import { dispatchEdu } from './edus.ts';
import { fetchMissingPrevs } from './missing.ts';
import type { Pdu } from '#engine/pdu.ts';

// The M5c hook point (SS:1236-1279): server ACLs check the origin
// against the room's m.room.server_acl here — a no-op in M5b.
function aclCheck(roomId: string, origin: string): void {
  void roomId;
  void origin;
}

export type TxnResult = { status: number; body: Record<string, unknown> };

export async function handleTransaction(
  origin: string,
  txnId: string,
  rawBody: unknown,
): Promise<TxnResult> {
  const body = (rawBody ?? {}) as {
    origin?: unknown;
    origin_server_ts?: unknown;
    pdus?: unknown;
    edus?: unknown;
  };
  // body origin must equal the authenticated origin (design.md — our
  // rule, stricter than the spec; tuwunel send.rs:84-88)
  if (body.origin !== origin) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'transaction origin does not match the authenticated server',
    );
  }
  const pdus = Array.isArray(body.pdus) ? body.pdus : [];
  const edus = Array.isArray(body.edus) ? body.edus : [];
  // 50 PDUs / 100 EDUs per transaction (SS:423-424)
  if (pdus.length > 50 || edus.length > 100) {
    throw new MatrixError(400, 'M_TOO_LARGE', 'too many PDUs or EDUs');
  }

  // replay: a retried transaction gets the stored answer
  const cached = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT response FROM federation_txns WHERE origin = $1 AND txn_id = $2;',
      [origin, txnId],
    );
    return r.rows.length ? JSON.parse(String(r.rows[0].response)) : null;
  });
  if (cached !== null) return { status: 200, body: cached };

  // group PDUs by room (v12 create: the room id derives from the event
  // id — v12.md:18-20, :100-101)
  const byRoom = new Map<string, Pdu[]>();
  for (const raw of pdus) {
    const pdu = raw as Pdu;
    let roomId = typeof pdu.room_id === 'string' ? pdu.room_id : null;
    if (
      roomId === null && pdu.type === 'm.room.create' &&
      typeof pdu.event_id === 'string'
    ) {
      roomId = '!' + String(pdu.event_id).slice(1);
    }
    if (roomId === null) continue; // no computable room — no result entry
    const list = byRoom.get(roomId) ?? [];
    list.push(pdu);
    byRoom.set(roomId, list);
  }
  const results: Record<string, Record<string, never> | { error: string }> = {};
  // the transaction-wide budget for missing-prev fetching (design point
  // D — when it is spent, the remaining PDUs with unknown prevs go
  // straight to the 'ungrounded' terminal and the answer goes out)
  const budget = { until: Date.now() + config().federation.missingbudgetms };
  await Promise.all([...byRoom.entries()].map(async ([roomId, roomPdus]) => {
    const room = await lookupRoom(roomId);
    // PDUs of one room in transaction order; the lock wraps only the
    // MUTATIONS — prechecks may fetch a key (network, never under the
    // lock; §3.2's discipline)
    for (const pdu of roomPdus) {
      aclCheck(roomId, origin);
      // the result key is the event's COMPUTED id (uncomputable → no
      // entry — Complement counts them,
      // federation_room_get_missing_events_test.go:292-294)
      let eventId: string;
      try {
        eventId = await eventIdFor(
          pdu as unknown as Record<string, unknown>,
          room?.roomVersion ?? '11',
        );
      } catch {
        continue;
      }
      try {
        if (room === null) {
          // no room_directory row (and no pending out-of-band invite —
          // commit 9's rescind arm is the one exception, §3.8 step 7)
          results[eventId] = { error: 'unknown room' };
          continue;
        }
        if (!(await serversInRoom(roomId)).includes(serverName())) {
          // a room we left is a room we are not in (§3.6a — a
          // membership fact, never a chapter fact)
          results[eventId] = { error: 'not participating' };
          continue;
        }
        const pre = await ingestPrechecks(roomId, pdu, {
          remote: { origin, position: 'after' },
        });
        if (pre.kind === 'early') {
          results[eventId] = {}; // known event — "successfully handled"
          continue;
        }
        // §3.4: the bounded fetch chain, UNLOCKED, then one locked retry;
        // a prev still unknown lands the 'ungrounded' terminal
        let landed = false;
        await withRoomLock(roomId, async () => {
          try {
            await ingestEventLocked(roomId, pdu, {
              remote: { origin, position: 'after' },
            }, pre.pre);
            landed = true;
          } catch (e) {
            if (!String(e).includes('M_UNKNOWN_PREV')) throw e;
          }
        });
        if (!landed) {
          await fetchMissingPrevs(roomId, pdu, origin, budget);
          await withRoomLock(roomId, async () => {
            try {
              await ingestEventLocked(roomId, pdu, {
                remote: { origin, position: 'after' },
              }, pre.pre);
            } catch (e) {
              if (String(e).includes('M_UNKNOWN_PREV')) {
                await storeUngroundedLocked(roomId, pdu, origin);
              } else {
                throw e;
              }
            }
          });
        }
        results[eventId] = {};
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')
        ) {
          // rejection is NOT a transaction error (SS:565-566): the event
          // was stored (rejected); Complement's MustSendTransaction
          // fatals on any error entry
          results[eventId] = {};
        } else if (msg.startsWith('Error: ')) {
          results[eventId] = { error: msg.slice(7) };
        } else {
          results[eventId] = { error: msg };
        }
      }
    }
  }));

  // EDUs after PDUs: unknown types ignored, errors in one never fail
  for (const raw of edus) {
    try {
      await dispatchEdu(origin, raw);
    } catch (e) {
      console.error(`transactions[${origin}]: EDU dropped:`, e);
    }
  }

  const response = { pdus: results };
  // the replay cache — pruned on insert after txnhours
  await withDb(serverDb(), async (c) => {
    await c.query(
      'DELETE FROM federation_txns WHERE received_ms < $1;',
      [Date.now() - config().federation.txnhours * 3_600_000],
    );
    await c.query(
      'INSERT INTO federation_txns (origin, txn_id, received_ms, response) VALUES ($1, $2, $3, $4) ON CONFLICT (origin, txn_id) DO UPDATE SET received_ms = $3, response = $4;',
      [origin, txnId, Date.now(), JSON.stringify(response)],
    );
  });
  return { status: 200, body: response };
}
