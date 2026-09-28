// api/engine/federation/outbox.ts — the durable outbox (D2) and the
// per-destination delivery memory. Rows are written by ingest in the
// same server-DB transaction as the event's index row (P2) and leave by
// exactly three doors: success, the operator's `prune`, or the
// refusedmillihours expiry with its admin alert (ruling E). Config =
// how the process runs; the rows are runtime data.
import type pgpkg from 'pg';
import { serverDb, withDb } from '#engine/db.ts';
import { config } from '#engine/config.ts';
import { recordPending } from './peers.ts';

export type OutboxRow = {
  id: number;
  destination: string;
  roomId: string;
  kind: 'event' | 'intent';
  eventId: string | null;
  intent: Record<string, unknown> | null;
  inflightTxn: string | null;
  inflightTs: number | null;
  addedMs: number;
  expiresMs: number;
};

// deno-lint-ignore no-explicit-any
function outboxRowOf(row: any): OutboxRow {
  return {
    id: Number(row.id),
    destination: String(row.destination),
    roomId: String(row.room_id),
    kind: String(row.kind) as OutboxRow['kind'],
    eventId: row.event_id == null ? null : String(row.event_id),
    intent: row.intent == null
      ? null
      : (typeof row.intent === 'string'
        ? JSON.parse(row.intent)
        : row.intent) as Record<string, unknown>,
    inflightTxn: row.inflight_txn == null ? null : String(row.inflight_txn),
    inflightTs: row.inflight_ts == null ? null : Number(row.inflight_ts),
    addedMs: Number(row.added_ms),
    expiresMs: Number(row.expires_ms),
  };
}

// Called by ingest INSIDE its index-write transaction (P2): the client
// `c` is mid-transaction. expires per ruling E (refusedmillihours).
export async function writeRows(
  c: pgpkg.Client,
  rows: {
    destination: string;
    roomId: string;
    kind: 'event' | 'intent';
    eventId?: string;
    intent?: Record<string, unknown>;
  }[],
): Promise<void> {
  const expiresMs = Date.now() +
    config().federation.refusedmillihours * 3_600; // millihours → ms
  for (const r of rows) {
    await c.query(
      'INSERT INTO federation_outbox (destination, room_id, kind, event_id, intent, added_ms, expires_ms) VALUES ($1, $2, $3, $4, $5, $6, $7);',
      [
        r.destination,
        r.roomId,
        r.kind,
        r.eventId ?? null,
        r.intent === undefined ? null : JSON.stringify(r.intent),
        Date.now(),
        expiresMs,
      ],
    );
  }
}

export async function destinationsWithRows(): Promise<string[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT DISTINCT destination FROM federation_outbox;',
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.destination));
  });
}

// The next event batch for a destination: the frozen in-flight batch if
// one exists (a restart resends EXACTLY that transaction — D2), else the
// oldest ≤ limit event rows, which the caller then freezes.
export async function eventBatchFor(
  destination: string,
  limit: number,
): Promise<{ rows: OutboxRow[]; frozen: boolean }> {
  return await withDb(serverDb(), async (c) => {
    const frozen = await c.query(
      `SELECT * FROM federation_outbox
       WHERE destination = $1 AND kind = 'event' AND inflight_txn IS NOT NULL
       ORDER BY id;`,
      [destination],
    );
    if (frozen.rows.length > 0) {
      // deno-lint-ignore no-explicit-any
      return { rows: (frozen.rows as any[]).map(outboxRowOf), frozen: true };
    }
    const r = await c.query(
      `SELECT * FROM federation_outbox
       WHERE destination = $1 AND kind = 'event' AND inflight_txn IS NULL
       ORDER BY id LIMIT $2;`,
      [destination, limit],
    );
    // deno-lint-ignore no-explicit-any
    return { rows: (r.rows as any[]).map(outboxRowOf), frozen: false };
  });
}

export async function oldestIntentFor(
  destination: string,
): Promise<OutboxRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT * FROM federation_outbox
       WHERE destination = $1 AND kind = 'intent'
       ORDER BY id LIMIT 1;`,
      [destination],
    );
    return r.rows.length === 0 ? null : outboxRowOf(r.rows[0]);
  });
}

export async function markInflight(
  ids: number[],
  txnId: string,
  ts: number,
): Promise<void> {
  if (ids.length === 0) return;
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE federation_outbox SET inflight_txn = $2, inflight_ts = $3 WHERE id = ANY($1);',
      [ids, txnId, ts],
    );
  });
}

// Batch retirement (r4, astra): an expired row inside the frozen batch
// retires it — the frozen body is discarded (inflight cleared on the
// survivors); the next attempt is a NEW transaction with a new txnId (a
// changed body may never reuse an id).
export async function retireInflight(destination: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE federation_outbox SET inflight_txn = NULL, inflight_ts = NULL WHERE destination = $1;',
      [destination],
    );
  });
}

export async function deleteRows(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM federation_outbox WHERE id = ANY($1);', [ids]);
  });
}

export async function moveIntentTo(
  id: number,
  destination: string,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE federation_outbox SET destination = $2 WHERE id = $1;',
      [id, destination],
    );
  });
}

// Expired rows for a destination (the sweep runs before the backoff
// skip — a destination deep in backoff must still surface lapsed rows).
export async function expiredFor(destination: string): Promise<OutboxRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT * FROM federation_outbox WHERE destination = $1 AND expires_ms <= $2 ORDER BY id;',
      [destination, Date.now()],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map(outboxRowOf);
  });
}

// --- per-destination delivery memory -------------------------------------

export type PeerStatus = {
  destination: string;
  failures: number;
  attemptsTotal: number;
  failuresTotal: number;
  unreachableSinceMs: number | null;
  nextAttemptMs: number;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  lastInboundMs: number | null;
  lastError: string | null;
};

// deno-lint-ignore no-explicit-any
function peerStatusOf(row: any): PeerStatus {
  return {
    destination: String(row.destination),
    failures: Number(row.failures),
    attemptsTotal: Number(row.attempts_total),
    failuresTotal: Number(row.failures_total),
    unreachableSinceMs: row.unreachable_since_ms == null
      ? null
      : Number(row.unreachable_since_ms),
    nextAttemptMs: Number(row.next_attempt_ms),
    lastAttemptMs: row.last_attempt_ms == null
      ? null
      : Number(row.last_attempt_ms),
    lastSuccessMs: row.last_success_ms == null
      ? null
      : Number(row.last_success_ms),
    lastInboundMs: row.last_inbound_ms == null
      ? null
      : Number(row.last_inbound_ms),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

export async function peerStatus(
  destination: string,
): Promise<PeerStatus> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT * FROM federation_peer_status WHERE destination = $1;',
      [destination],
    );
    if (r.rows.length > 0) return peerStatusOf(r.rows[0]);
    return {
      destination,
      failures: 0,
      attemptsTotal: 0,
      failuresTotal: 0,
      unreachableSinceMs: null,
      nextAttemptMs: 0,
      lastAttemptMs: null,
      lastSuccessMs: null,
      lastInboundMs: null,
      lastError: null,
    };
  });
}

export async function listPeerStatus(): Promise<PeerStatus[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT * FROM federation_peer_status ORDER BY destination;',
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map(peerStatusOf);
  });
}

export async function recordSuccess(destination: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO federation_peer_status (destination, failures, attempts_total, last_attempt_ms, last_success_ms)
       VALUES ($1, 0, 1, $2, $2)
       ON CONFLICT (destination) DO UPDATE SET failures = 0,
         unreachable_since_ms = NULL, attempts_total = federation_peer_status.attempts_total + 1,
         last_attempt_ms = $2, last_success_ms = $2, last_error = NULL;`,
      [destination, Date.now()],
    );
  });
}

// Any non-2xx (ruling E): the ladder advances; rows are KEPT.
export async function recordFailure(
  destination: string,
  error: string,
  backoffMs: number,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO federation_peer_status (destination, failures, attempts_total, failures_total, unreachable_since_ms, next_attempt_ms, last_attempt_ms, last_error)
       VALUES ($1, 1, 1, 1, $2, $3, $2, $4)
       ON CONFLICT (destination) DO UPDATE SET failures = federation_peer_status.failures + 1,
         attempts_total = federation_peer_status.attempts_total + 1,
         failures_total = federation_peer_status.failures_total + 1,
         unreachable_since_ms = COALESCE(federation_peer_status.unreachable_since_ms, $2),
         next_attempt_ms = $3, last_attempt_ms = $2, last_error = $4;`,
      [destination, Date.now(), Date.now() + backoffMs, error],
    );
  });
}

// Inbound contact resets the ladder (D2) and wakes the queue.
export async function notifyPeerAlive(destination: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO federation_peer_status (destination, failures, next_attempt_ms, last_inbound_ms)
       VALUES ($1, 0, 0, $2)
       ON CONFLICT (destination) DO UPDATE SET failures = 0,
         next_attempt_ms = 0, last_inbound_ms = $2;`,
      [destination, Date.now()],
    );
  });
}

// The 'refused' pending entry (ruling E): upsert with a count — repeated
// refusals are one row; the detail carries the last refusal and how many
// rows have expired undelivered.
export async function recordRefusal(
  destination: string,
  last: {
    code: number | null;
    errcode: string | null;
    error: string;
    txnId: string | null;
  },
  expiredRows: number,
): Promise<void> {
  await recordPending(
    destination,
    'refused',
    true,
    JSON.stringify({ last, expired_rows: expiredRows }),
  );
}

// The tool's doors: retry (ladder reset + expires refreshed — else the
// woken loop sweeps the rows — and re-queue) and prune (operator).
export async function retryDestination(destination: string): Promise<void> {
  const expiresMs = Date.now() +
    config().federation.refusedmillihours * 3_600; // millihours → ms
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE federation_outbox SET expires_ms = $2, inflight_txn = NULL, inflight_ts = NULL WHERE destination = $1;',
      [destination, expiresMs],
    );
    await c.query(
      `INSERT INTO federation_peer_status (destination, failures, next_attempt_ms)
       VALUES ($1, 0, 0)
       ON CONFLICT (destination) DO UPDATE SET failures = 0, next_attempt_ms = 0, unreachable_since_ms = NULL;`,
      [destination],
    );
  });
}

export async function pruneDestination(destination: string): Promise<number> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'DELETE FROM federation_outbox WHERE destination = $1;',
      [destination],
    );
    return r.rowCount !== undefined ? r.rowCount : 0;
  });
}

export async function listOutbox(
  destination?: string,
): Promise<OutboxRow[]> {
  return await withDb(serverDb(), async (c) => {
    const r = destination === undefined
      ? await c.query(
        'SELECT * FROM federation_outbox ORDER BY destination, id;',
      )
      : await c.query(
        'SELECT * FROM federation_outbox WHERE destination = $1 ORDER BY id;',
        [destination],
      );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map(outboxRowOf);
  });
}
