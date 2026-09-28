// api/engine/federation/sender.ts — the outbound delivery loop (D2).
// One loop per destination, started lazily when a row for it appears
// (onEventApplied → wakeDestination) or at startup for every destination
// with rows. One transaction in flight per destination; the in-flight
// batch is marked and frozen in the outbox table, so a restart resends
// exactly that batch — same txnId, same origin_server_ts, same PDUs;
// the EDUs of a frozen batch are kept in memory while the process lives
// (a restart resends PDUs only — they were never persisted). Every
// non-2xx is retried on the millihour ladder (ruling E); rows leave by
// exactly three doors: success, the operator's prune, or the
// refusedmillihours expiry with its admin alert. Inbound contact resets
// the ladder (notifyPeerAlive — the X-Matrix middleware calls it, §3.3).
import { config, serverName } from '#engine/config.ts';
import { onEventApplied } from '#engine/ingest.ts';
import { onTypingChange } from '#engine/typing.ts';
import { onReceiptChange } from '#engine/receipts.ts';
import { onPresenceChange } from '#engine/presence.ts';
import { serversInRoom } from '#engine/room.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { federationRequest } from './client.ts';
import { admit } from './gate.ts';
import { isBlocked } from './peers.ts';
import * as outbox from './outbox.ts';
import {
  drainEdus,
  type Edu,
  queuePresence,
  queueReceipt,
  queueTyping,
} from './edus.ts';
import { toWire } from './pdu.ts';
import { registerRejectInvitePerformer } from './invites.ts';

// --- intent performers (ruling F) ----------------------------------------
// Intent rows never enter a /send batch: an intent is attempted by the
// loop of its CURRENT destination only, on that destination's ladder,
// one attempt per wake. The performer is registered per intent kind —
// commit 9 registers 'reject-invite'.
export type IntentPerformer = (
  destination: string,
  intent: Record<string, unknown>,
) => Promise<void>;
const performers = new Map<string, IntentPerformer>();
export function registerIntentPerformer(
  what: string,
  performer: IntentPerformer,
): void {
  performers.set(what, performer);
}

// --- wake plumbing ---------------------------------------------------------
const running = new Set<string>();
const wakers = new Map<string, () => void>();
// the frozen batch's EDUs, in-memory while the process lives (D2)
const frozenEdus = new Map<string, Edu[]>();
let txnCounter = 0;

export function wakeDestination(destination: string): void {
  wakers.get(destination)?.();
  if (!running.has(destination)) {
    running.add(destination);
    void loop(destination)
      .catch((e) => console.error(`sender[${destination}] error:`, e))
      .finally(() => running.delete(destination));
  }
}

let senderStarted = false;
export function startSender(): void {
  if (senderStarted) return;
  senderStarted = true;
  // commit 9's reject-invite performer, on commit 3's registry
  registerRejectInvitePerformer();
  // the wake path tolerates a missing outbox table (the app boots before
  // db-init on a fresh container; a pre-existing DB may lack the M5b
  // tables until the documented ALTER — either way, rows never lost:
  // the next wake re-scans)
  const scan = () =>
    outbox.destinationsWithRows()
      .then((ds: string[]) => {
        for (const d of ds) wakeDestination(d);
      })
      .catch(() => {});
  onEventApplied(() => {
    void scan();
  });
  wireEduFeeds();
  void scan();
}

// --- EDU feeds: local users only, destinations from the room's servers ---
let feedsWired = false;
function wireEduFeeds(): void {
  if (feedsWired) return;
  feedsWired = true;
  onTypingChange((roomId, userId, isTyping) => {
    const seq = ++eduSeq;
    void serversInRoom(roomId).then((servers) => {
      for (const d of servers) {
        if (d === serverName()) continue;
        queueEduTyping(d, roomId, userId, isTyping, seq);
      }
    });
  });
  onReceiptChange((roomId, userId, _receiptType, eventId) => {
    const seq = ++eduSeq;
    void serversInRoom(roomId).then((servers) => {
      for (const d of servers) {
        if (d === serverName()) continue;
        queueEduReceipt(d, roomId, userId, eventId, seq);
      }
    });
  });
  onPresenceChange((userId, presence, statusMsg) => {
    const seq = ++eduSeq;
    void serversSharingRoomWith(userId).then((servers) => {
      for (const d of servers) {
        if (d === serverName()) continue;
        queueEduPresence(d, userId, presence, statusMsg, seq);
      }
    });
  });
}

async function serversSharingRoomWith(userId: string): Promise<string[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT DISTINCT m2.user_id FROM room_membership m1
       JOIN room_membership m2 ON m1.room_id = m2.room_id
       WHERE m1.user_id = $1 AND m1.membership = 'join' AND m2.membership = 'join';`,
      [userId],
    );
    const domains = new Set<string>();
    // deno-lint-ignore no-explicit-any
    for (const row of r.rows as any[]) {
      const uid = String(row.user_id);
      const at = uid.indexOf(':');
      if (at >= 0) domains.add(uid.slice(at + 1));
    }
    return [...domains];
  });
}

// thin wrappers so the feed code reads in EDU terms; the seq is issued
// SYNCHRONOUSLY at listener fire so an async late landing can never
// overwrite a fresher change (the coalescing guard in edus.ts)
let eduSeq = 0;
function queueEduTyping(
  d: string,
  roomId: string,
  userId: string,
  typing: boolean,
  seq: number,
) {
  queueTyping(d, roomId, userId, typing, seq);
}
function queueEduReceipt(
  d: string,
  roomId: string,
  userId: string,
  eventId: string,
  seq: number,
) {
  queueReceipt(
    d,
    { roomId, userId, eventId, ts: Date.now(), threadId: null },
    seq,
  );
}
function queueEduPresence(
  d: string,
  userId: string,
  presence: string,
  statusMsg: string | null,
  seq: number,
) {
  queuePresence(d, {
    user_id: userId,
    presence,
    status_msg: statusMsg,
    last_active_ago: 0,
    currently_active: presence === 'online',
  }, seq);
}

// --- the loop ---------------------------------------------------------------

function sleep(ms: number, destination: string): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      wakers.delete(destination);
      resolve();
    }, ms);
    wakers.set(destination, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function backoffMs(failures: number): number {
  const fed = config().federation;
  const mh = Math.min(
    fed.backoffstartmillihours * 2 ** Math.max(0, failures - 1),
    fed.backoffmaxmillihours,
  );
  return mh * 3_600; // millihours → ms
}

async function loop(destination: string): Promise<void> {
  for (;;) {
    // 0. expiry FIRST (r4, muse): lapsed rows surface even deep in
    //    backoff; an expired row inside the frozen batch retires it.
    await sweepExpired(destination);
    // intent rows: their own path, one attempt per wake
    const intent = await outbox.oldestIntentFor(destination);
    if (intent !== null) {
      await attemptIntent(destination, intent);
      continue;
    }
    // 1. backoff skip
    const status = await outbox.peerStatus(destination);
    const wait = status.nextAttemptMs - Date.now();
    if (wait > 0) {
      await sleep(wait, destination);
      continue;
    }
    // a block added later stops the loop; rows left in place for the
    // operator's prune
    if (await isBlocked(destination)) return;
    // 2. the batch — event rows only (intents never enter a /send body)
    const batch = await outbox.eventBatchFor(destination, 50);
    let edus: Edu[];
    let txnId: string | null = null;
    let txnTs = Date.now();
    if (batch.frozen) {
      txnId = batch.rows[0].inflightTxn;
      txnTs = batch.rows[0].inflightTs ?? txnTs;
      // the frozen batch's EDUs ride again, in-memory only (D2)
      edus = txnId !== null ? (frozenEdus.get(txnId) ?? []) : [];
    } else {
      edus = drainEdus(destination, 100);
    }
    if (batch.rows.length === 0 && edus.length === 0) return;
    if (!batch.frozen) {
      txnId = `${Date.now()}-${++txnCounter}`;
      if (batch.rows.length > 0) {
        await outbox.markInflight(
          batch.rows.map((r) => r.id),
          txnId,
          txnTs,
        );
        if (edus.length > 0) frozenEdus.set(txnId, edus);
      }
    }
    // 3. wire form: stored canonical minus event_id/unsigned (pdu.ts)
    const pdus: Record<string, unknown>[] = [];
    for (const row of batch.rows) {
      const pdu = await pduOf(row.roomId, row.eventId!);
      if (pdu !== null) pdus.push(pdu);
    }
    try {
      const res = await federationRequest({
        destination,
        method: 'PUT',
        path: `/_matrix/federation/v1/send/${encodeURIComponent(txnId!)}`,
        body: new TextEncoder().encode(
          JSON.stringify({
            origin: serverName(),
            origin_server_ts: txnTs,
            pdus,
            edus: edus.map((e) => ({ ...e })),
          }),
        ),
      });
      // 2xx — delivered: delete the batch's rows, reset the ladder
      await outbox.deleteRows(batch.rows.map((r) => r.id));
      if (txnId !== null) frozenEdus.delete(txnId);
      await outbox.recordSuccess(destination);
      const body = res.json as
        | { pdus?: Record<string, { error?: string }> }
        | null;
      for (const [id, verdict] of Object.entries(body?.pdus ?? {})) {
        if (verdict?.error !== undefined) {
          console.warn(
            `sender[${destination}]: receiver rejected ${id}: ${verdict.error}`,
          );
        }
      }
    } catch (e) {
      await handleSendFailure(destination, txnId, e);
    }
  }
}

async function pduOf(
  roomId: string,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return null;
    const dbName = await roomDbOf(c, roomId);
    if (dbName === null) return null;
    return await withDb(dbName, async (rc) => {
      const rr = await rc.query(
        `SELECT canonical_json FROM events AS OF '${
          String(r.rows[0].commit_hash)
        }' WHERE event_id = $1;`,
        [eventId],
      );
      if (rr.rows.length === 0) return null;
      const room = await roomVersionOf(c, roomId);
      return toWire(
        typeof rr.rows[0].canonical_json === 'string'
          ? JSON.parse(String(rr.rows[0].canonical_json))
          : rr.rows[0].canonical_json,
        room ?? '11',
      );
    });
  });
}

// deno-lint-ignore no-explicit-any
async function roomDbOf(c: any, roomId: string): Promise<string | null> {
  const r = await c.query(
    'SELECT db_name FROM room_directory WHERE room_id = $1;',
    [roomId],
  );
  return r.rows.length === 0 ? null : String(r.rows[0].db_name);
}

// deno-lint-ignore no-explicit-any
async function roomVersionOf(c: any, roomId: string): Promise<string | null> {
  const r = await c.query(
    'SELECT room_version FROM room_directory WHERE room_id = $1;',
    [roomId],
  );
  return r.rows.length === 0 ? null : String(r.rows[0].room_version);
}

async function handleSendFailure(
  destination: string,
  txnId: string | null,
  e: unknown,
): Promise<void> {
  const status = await outbox.peerStatus(destination);
  const err = e as { status?: number; errcode?: string; message?: string };
  await outbox.recordFailure(
    destination,
    `${err.status ?? 'net'} ${err.message ?? String(e)}`,
    backoffMs(status.failures + 1),
  );
  // a refusal (4xx with a Matrix body) also writes the 'refused' pending
  // entry so the admin sees it at once (ruling E)
  if (
    typeof err.status === 'number' && err.status >= 400 && err.status < 500
  ) {
    await outbox.recordRefusal(destination, {
      code: err.status,
      errcode: err.errcode ?? null,
      error: err.message ?? String(e),
      txnId,
    }, 0);
  }
}

async function sweepExpired(destination: string): Promise<void> {
  const expired = await outbox.expiredFor(destination);
  if (expired.length === 0) return;
  // an expired row inside the frozen batch retires the batch (r4, astra)
  if (expired.some((r) => r.inflightTxn !== null)) {
    await outbox.retireInflight(destination);
  }
  await outbox.deleteRows(expired.map((r) => r.id));
  const last = expired[expired.length - 1];
  await outbox.recordRefusal(
    destination,
    {
      code: null,
      errcode: null,
      error:
        `expired ${expired.length} undelivered row(s) after the refusedmillihours lifespan`,
      txnId: last.inflightTxn,
    },
    expired.length,
  );
}

// intent rows: perform → delete; any failure → advance to the next
// candidate (wrapping), wake it, and count on this destination's ladder
async function attemptIntent(
  destination: string,
  row: outbox.OutboxRow,
): Promise<void> {
  const intent = row.intent ?? {};
  const what = typeof intent.what === 'string' ? intent.what : '';
  const performer = performers.get(what);
  if (performer === undefined) {
    // an unknown intent kind is an operator-visible dead end, never a loop
    await outbox.recordRefusal(destination, {
      code: null,
      errcode: null,
      error: `no performer registered for intent '${what}'`,
      txnId: null,
    }, 0);
    await outbox.deleteRows([row.id]);
    return;
  }
  try {
    // blocks and closed mode apply to every candidate (r4, astra)
    await admit(destination, {
      kind: 'outbound',
      user: typeof intent.user_id === 'string' ? intent.user_id : 'sender',
      what: `intent:${what}`,
    });
    await performer(destination, intent);
    await outbox.deleteRows([row.id]);
  } catch (e) {
    const candidates = Array.isArray(intent.candidates)
      ? intent.candidates.map(String)
      : [];
    const at = candidates.indexOf(destination);
    const next = candidates.length === 0
      ? null
      : candidates[(at + 1) % candidates.length];
    const status = await outbox.peerStatus(destination);
    await outbox.recordFailure(
      destination,
      (e as Error).message ?? String(e),
      backoffMs(status.failures + 1),
    );
    if (next !== null && next !== destination) {
      await outbox.moveIntentTo(row.id, next);
      wakeDestination(next);
    }
  }
}

/** Tests simulate a restart: the frozen batches' EDU cache is in-memory. */
export function resetSenderForTests(): void {
  frozenEdus.clear();
}
