// api/engine/federation/sender.ts — the outbound delivery loop (old D2,
// on the 4b outbox). One loop per destination, started lazily when a row
// for it appears (projection insert → the onProjected rescan → wake) or
// at startSender for every destination with pending rows (a restart
// picks up exactly what was pending). The batch is DERIVED: the oldest
// ≤ 50 pending rows in feed order, and the transaction — id and
// origin_server_ts — derives deterministically from it, so a retry
// (process restart or not) resends exactly that transaction; a changed
// body (rows delivered or expired meanwhile) derives a different id,
// the old "a changed body may never reuse an id". The frozen batch's
// EDUs ride in memory while the process lives (never persisted — after
// a restart the resend carries PDUs only). Every non-2xx is retried on
// the millihour ladder (peer_status is the timing source; the rows
// mirror it); rows leave pending by exactly three doors — sent, the
// operator's prune, or the refusedmillihours expiry with its admin
// alert (ruling E). Inbound contact resets the ladder (contactHook —
// auth.ts's onContact wires it into every authenticated endpoint).
// Delivery truth stays in the server file; never derived again.
import { config } from '#engine/config.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom } from '#engine/room/index.ts';
import type { Signer } from '#engine/room/signer.ts';
import { onProjected } from '#engine/server/project.ts';
import { outboxDue, type OutboxDueRow } from '#engine/server/read.ts';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { b64encode, sha256ofString } from '#engine/signing-primitives.js';
import { federationRequest } from './client.ts';
import { isBlocked, recordPending } from './peers.ts';

export type Edu = { edu_type: string; content: Record<string, unknown> };

// --- outbox reads ------------------------------------------------------------

export type OutboxRow = {
  room: string;
  pos: number;
  destination: string;
  event: string;
  state: string;
  attempts: number;
  nextAttemptMs: number;
  addedMs: number;
};

// deno-lint-ignore no-explicit-any
function outboxRowOf(row: any): OutboxRow {
  return {
    room: String(row.room),
    pos: Number(row.pos),
    destination: String(row.destination),
    event: String(row.event),
    state: String(row.state),
    attempts: Number(row.attempts),
    nextAttemptMs: Number(row.next_attempt_ms),
    addedMs: Number(row.added_ms),
  };
}

export async function listOutbox(
  server: Db,
  destination?: string,
): Promise<OutboxRow[]> {
  const rows = destination === undefined
    ? await server.query(
      'SELECT room, pos, destination, event, state, attempts, next_attempt_ms, added_ms FROM outbox ORDER BY destination, room, pos',
      [],
    )
    : await server.query(
      'SELECT room, pos, destination, event, state, attempts, next_attempt_ms, added_ms FROM outbox WHERE destination = ? ORDER BY room, pos',
      [destination],
    );
  return rows.map(outboxRowOf);
}

// Destinations with undelivered rows (the startSender / projection rescan).
async function destinationsWithPending(server: Db): Promise<string[]> {
  const rows = await server.query(
    "SELECT DISTINCT destination FROM outbox WHERE state = 'pending'",
    [],
  );
  return rows.map((row) => String(row.destination));
}

// --- per-destination delivery memory (peer_status) ---------------------------

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
    unreachableSinceMs: row.unreachable_since_ms === null
      ? null
      : Number(row.unreachable_since_ms),
    nextAttemptMs: Number(row.next_attempt_ms),
    lastAttemptMs: row.last_attempt_ms === null
      ? null
      : Number(row.last_attempt_ms),
    lastSuccessMs: row.last_success_ms === null
      ? null
      : Number(row.last_success_ms),
    lastInboundMs: row.last_inbound_ms === null
      ? null
      : Number(row.last_inbound_ms),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

export async function peerStatus(
  server: Pick<Db, 'query'>,
  destination: string,
): Promise<PeerStatus> {
  const rows = await server.query(
    'SELECT * FROM peer_status WHERE destination = ?',
    [destination],
  );
  if (rows.length > 0) return peerStatusOf(rows[0]);
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
}

export async function listPeerStatus(server: Db): Promise<PeerStatus[]> {
  const rows = await server.query(
    'SELECT * FROM peer_status ORDER BY destination',
    [],
  );
  return rows.map(peerStatusOf);
}

export async function recordSuccess(
  server: Pick<Db, 'execute'>,
  destination: string,
): Promise<void> {
  const now = Date.now();
  await server.execute(
    `INSERT INTO peer_status(destination, failures, attempts_total, last_attempt_ms, last_success_ms)
     VALUES(?, 0, 1, ?, ?)
     ON CONFLICT(destination) DO UPDATE SET failures = 0,
       unreachable_since_ms = NULL, attempts_total = peer_status.attempts_total + 1,
       last_attempt_ms = excluded.last_attempt_ms,
       last_success_ms = excluded.last_success_ms, last_error = NULL`,
    [destination, now, now],
  );
}

// Any non-2xx (ruling E): the ladder advances; rows are KEPT (the batch
// rows' attempts/next_attempt_ms mirror the ladder step).
export async function recordFailure(
  server: Pick<Db, 'execute'>,
  destination: string,
  error: string,
  backoffMs: number,
  now = Date.now(),
): Promise<void> {
  await server.execute(
    `INSERT INTO peer_status(destination, failures, attempts_total, failures_total, unreachable_since_ms, next_attempt_ms, last_attempt_ms, last_error)
     VALUES(?, 1, 1, 1, ?, ?, ?, ?)
     ON CONFLICT(destination) DO UPDATE SET failures = peer_status.failures + 1,
       attempts_total = peer_status.attempts_total + 1,
       failures_total = peer_status.failures_total + 1,
       unreachable_since_ms = COALESCE(peer_status.unreachable_since_ms, excluded.unreachable_since_ms),
       next_attempt_ms = excluded.next_attempt_ms,
       last_attempt_ms = excluded.last_attempt_ms, last_error = excluded.last_error`,
    [destination, now, now + backoffMs, now, error],
  );
}

// Inbound contact resets the ladder (D2) — the batch's per-row mirrors
// clear with it, so the next batch derives over every pending row.
export async function notifyPeerAlive(
  server: Db,
  destination: string,
): Promise<void> {
  const now = Date.now();
  await server.tx(async (tx) => {
    await tx.execute(
      `INSERT INTO peer_status(destination, failures, next_attempt_ms, last_inbound_ms)
       VALUES(?, 0, 0, ?)
       ON CONFLICT(destination) DO UPDATE SET failures = 0,
         next_attempt_ms = 0, last_inbound_ms = excluded.last_inbound_ms`,
      [destination, now],
    );
    await tx.execute(
      "UPDATE outbox SET next_attempt_ms = 0 WHERE destination = ? AND state = 'pending'",
      [destination],
    );
  });
}

// The 'refused' pending entry (ruling E): upsert with a count — repeated
// refusals are one row; the detail carries the last refusal and how many
// rows have expired undelivered.
export async function recordRefusal(
  server: Db | Conn,
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
    server,
    destination,
    'refused',
    true,
    JSON.stringify({ last, expired_rows: expiredRows }),
  );
}

// The tool's doors: retry (ladder reset + expiry refreshed by re-basing
// added_ms — the next attempt derives a NEW transaction, like the old
// cleared-inflight re-queue) and prune (operator).
export async function retryDestination(
  server: Db,
  destination: string,
): Promise<void> {
  const now = Date.now();
  await server.tx(async (tx) => {
    await tx.execute(
      "UPDATE outbox SET added_ms = ?, next_attempt_ms = 0, attempts = 0 WHERE destination = ? AND state = 'pending'",
      [now, destination],
    );
    await tx.execute(
      `INSERT INTO peer_status(destination, failures, next_attempt_ms)
       VALUES(?, 0, 0)
       ON CONFLICT(destination) DO UPDATE SET failures = 0, next_attempt_ms = 0, unreachable_since_ms = NULL`,
      [destination],
    );
  });
}

export async function pruneDestination(
  server: Db,
  destination: string,
): Promise<number> {
  return await server.execute('DELETE FROM outbox WHERE destination = ?', [
    destination,
  ]);
}

// --- intents (the reject-invite dance's provider; invites.ts registers) ------

// One intent per wake, attempted on this destination's ladder — the old
// loop shape. run() performs it (admit inside, per candidate); on a
// throw the loop counts the ladder and failed() advances the candidate.
export type IntentJob = {
  id: string;
  run(): Promise<void>;
  failed(e: unknown): Promise<void>;
};
export type IntentProvider = (
  server: Db,
  destination: string,
) => Promise<IntentJob | null>;

export type ReviewIntent = {
  id: string;
  destination: string;
  kind: 'intent';
  eventId: null;
  intent: { what: string; user_id: string; candidates: string[] };
  addedMs: number;
  expiresMs: null;
  inflightTxn: null;
};

export type ReviewableIntentProvider = IntentProvider & {
  review(): Promise<ReviewIntent[]>;
  prune(destination: string): Promise<number>;
};

// --- the sender ---------------------------------------------------------------

export type SenderDeps = {
  store: Store;
  signer: Signer;
  // the EDU drain (edus.ts's queues; injected — the sender predates the
  // module and the frozen-batch cache lives here regardless)
  drainEdus?: (destination: string, limit: number) => Edu[];
};

export type Sender = {
  wake(destination: string): void;
  contactHook(): (origin: string) => void;
  setIntentProvider(provider: IntentProvider | null): void;
  stop(): Promise<void>;
  snapshot(): ReadonlyArray<
    { destination: string; txnId: string; rows: readonly string[] }
  >;
  reviewIntents(): Promise<ReviewIntent[] | null>;
  pruneIntents(destination: string): Promise<number | null>;
};

function backoffMs(failures: number): number {
  const fed = config().federation;
  const mh = Math.min(
    fed.backoffstartmillihours * 2 ** Math.max(0, failures - 1),
    fed.backoffmaxmillihours,
  );
  return mh * 3_600; // millihours → ms
}

// The derived transaction identity: stable while the batch is (same
// rows → same id and ts, restart or not), different the moment the body
// changes. ts = the newest row's added_ms (the old inflight ts's
// deterministic equivalent).
async function deriveTxn(
  destination: string,
  rows: OutboxDueRow[],
): Promise<{ txnId: string; ts: number }> {
  const ts = rows.reduce((m, r) => Math.max(m, r.addedMs), 0);
  const keys = rows.map((r) => `${r.room}:${r.pos}`).join('\n');
  const hash = b64encode(
    await sha256ofString(`${destination}\n${ts}\n${keys}`),
  );
  return { txnId: `${ts}-${hash.slice(0, 22)}`, ts };
}

export function startSender(deps: SenderDeps): Sender {
  const serverP = deps.store.server();
  const running = new Set<string>();
  const wakers = new Map<string, () => void>();
  // the derived transaction's EDUs, in-memory while the process lives
  const frozenEdus = new Map<string, Edu[]>();
  const inFlight = new Map<string, { txnId: string; rows: string[] }>();
  let eduTxnCounter = 0;
  let intentProvider: IntentProvider | null = null;
  let stopped = false;
  const loops = new Set<Promise<void>>();

  function sleep(ms: number, destination: string): Promise<void> {
    // The stopped latch and registration are synchronous: stop either drains
    // this wait or prevents it from starting, even after an earlier await.
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(t);
        wakers.delete(destination);
        resolve();
      };
      const t = setTimeout(finish, ms);
      wakers.set(destination, finish);
    });
  }

  function wake(destination: string): void {
    wakers.get(destination)?.();
    if (!running.has(destination) && !stopped) {
      running.add(destination);
      const loop = loopDestination(destination)
        .catch((e) => console.error(`sender[${destination}] error:`, e))
        .finally(() => {
          running.delete(destination);
          loops.delete(loop);
        });
      loops.add(loop);
    }
  }

  async function sweepExpired(destination: string): Promise<void> {
    const server = await serverP;
    const cutoff = Date.now() - config().federation.refusedmillihours * 3_600;
    await server.tx(async (tx) => {
      // Selection and publication share the transaction, including a concurrent
      // operator retry's refreshed lifespan. A changed body retires its txn id.
      const expired = await tx.execute(
        "UPDATE outbox SET state = 'failed' WHERE destination = ? AND state = 'pending' AND added_ms <= ?",
        [destination, cutoff],
      );
      if (expired === 0) return;
      await recordRefusal(
        tx,
        destination,
        {
          code: null,
          errcode: null,
          error:
            `expired ${expired} undelivered row(s) after the refusedmillihours lifespan`,
          txnId: null,
        },
        expired,
      );
    });
  }

  async function attemptIntent(
    destination: string,
    job: IntentJob,
  ): Promise<void> {
    const server = await serverP;
    if (stopped) return;
    try {
      await job.run();
    } catch (e) {
      const status = await peerStatus(server, destination);
      await recordFailure(
        server,
        destination,
        (e as Error).message == null ? String(e) : (e as Error).message,
        backoffMs(status.failures + 1),
      );
      await job.failed(e);
    }
  }

  // The PDU of an outbox row: the room file's verbatim event (the old
  // canonical_json read) in wire form — no event_id, no unsigned.
  async function pduOf(
    roomId: string,
    eventId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const room = await openRoom(deps.store, roomId);
      const pdu = await room.tx(async (tx) => {
        const row = await tx.events.get(eventId);
        return row === null ? null : (JSON.parse(row.pdu) as Pdu);
      });
      if (pdu === null) return null;
      const wire = { ...(pdu as unknown as Record<string, unknown>) };
      delete wire.event_id;
      delete wire.unsigned;
      return wire;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async function loopDestination(destination: string): Promise<void> {
    for (;;) {
      if (stopped) return;
      // 0. expiry FIRST (r4, muse): lapsed rows surface even deep in
      //    backoff
      await sweepExpired(destination);
      if (stopped) return;
      // 1. backoff skip (the peer ladder is the timing source)
      const server = await serverP;
      const status = await peerStatus(server, destination);
      const wait = status.nextAttemptMs - Date.now();
      if (wait > 0) {
        await sleep(wait, destination);
        continue;
      }
      // Every delivery path uses the peer ladder, including retained intents.
      if (intentProvider !== null) {
        const job = await intentProvider(server, destination);
        if (job !== null) {
          await attemptIntent(destination, job);
          continue;
        }
      }
      // a block added later stops the loop; rows left in place for the
      // operator's prune
      if (await isBlocked(server, destination)) return;
      // 2. the derived batch — the oldest ≤ 50 pending rows in feed order
      const batch = await outboxDue(server, destination, Date.now(), 50);
      // the transaction: derived while PDUs ride (stable across retries
      // and restarts); an EDU-only send is ephemeral — a fresh id every
      // time (the old counter mint), never frozen, never retried
      let txnId: string;
      let ts: number;
      if (batch.length > 0) {
        const derived = await deriveTxn(destination, batch);
        txnId = derived.txnId;
        ts = derived.ts;
      } else {
        txnId = `${Date.now()}-${++eduTxnCounter}`;
        ts = Date.now();
      }
      let edus: Edu[];
      if (stopped) return;
      if (batch.length > 0 && frozenEdus.has(txnId)) {
        // a retry in this process: the frozen batch's EDUs ride again
        edus = frozenEdus.get(txnId) as Edu[];
      } else {
        edus = deps.drainEdus !== undefined
          ? deps.drainEdus(destination, 100)
          : [];
        if (batch.length > 0 && edus.length > 0) frozenEdus.set(txnId, edus);
      }
      if (batch.length === 0 && edus.length === 0) return;
      // 3. wire form PDUs from the room files
      const pdus: Record<string, unknown>[] = [];
      for (const row of batch) {
        const pdu = await pduOf(row.room, row.event);
        if (pdu !== null) pdus.push(pdu);
      }
      if (stopped) return;
      let res;
      try {
        inFlight.set(destination, {
          txnId,
          rows: batch.map((row) => `${row.room}:${row.pos}`),
        });
        res = await federationRequest(server, deps.signer, {
          destination,
          method: 'PUT',
          path: `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`,
          body: new TextEncoder().encode(
            JSON.stringify({
              origin: deps.signer.serverName,
              origin_server_ts: ts,
              pdus,
              edus: edus.map((e) => ({ ...e })),
            }),
          ),
          maxBytes: config().federation.bulkmaxbytes,
        });
      } catch (e) {
        const err = e as {
          status?: number;
          errcode?: string;
          message?: string;
        };
        const now = Date.now();
        await server.tx(async (tx) => {
          const fresh = await peerStatus(tx, destination);
          const backoff = backoffMs(fresh.failures + 1);
          await recordFailure(
            tx,
            destination,
            `${err.status == null ? 'net' : err.status} ${
              err.message == null ? String(e) : err.message
            }`,
            backoff,
            now,
          );
          // The peer ladder and all its row mirrors publish together.
          for (const row of batch) {
            await tx.execute(
              "UPDATE outbox SET attempts = attempts + 1, next_attempt_ms = ? WHERE room = ? AND pos = ? AND destination = ? AND state = 'pending'",
              [now + backoff, row.room, row.pos, destination],
            );
          }
          // A 4xx also publishes the operator's refusal in this transaction.
          if (
            typeof err.status === 'number' && err.status >= 400 &&
            err.status < 500
          ) {
            await recordRefusal(
              tx,
              destination,
              {
                code: err.status,
                errcode: err.errcode == null ? null : err.errcode,
                error: err.message == null ? String(e) : err.message,
                txnId,
              },
              0,
            );
          }
        });
        continue;
      } finally {
        inFlight.delete(destination);
      }
      // Persistence errors are not transport failures. Roll back the delivery
      // outcome as a unit, leaving the derived batch available after restart.
      await server.tx(async (tx) => {
        for (const row of batch) {
          await tx.execute(
            "UPDATE outbox SET state = 'sent' WHERE room = ? AND pos = ? AND destination = ?",
            [row.room, row.pos, destination],
          );
        }
        await recordSuccess(tx, destination);
      });
      frozenEdus.delete(txnId);
      const body = res.json as
        | { pdus?: Record<string, { error?: string }> }
        | null;
      const verdicts = body == null || body.pdus == null ? {} : body.pdus;
      for (const [id, verdict] of Object.entries(verdicts)) {
        if (verdict?.error !== undefined) {
          console.warn(
            `sender[${destination}]: receiver rejected ${id}: ${verdict.error}`,
          );
        }
      }
    }
  }

  // the projection wake: new outbox rows for any destination wake its
  // loop (this sender's store only — instances share the process)
  onProjected((store) => {
    if (store !== deps.store || stopped) return;
    void serverP.then((server) =>
      destinationsWithPending(server).then((ds) => {
        for (const d of ds) wake(d);
      })
    ).catch(() => {});
  });

  // a restart picks up pending rows
  void serverP.then((server) =>
    destinationsWithPending(server).then((ds) => {
      for (const d of ds) wake(d);
    })
  ).catch(() => {});

  return {
    wake,
    snapshot: () =>
      [...inFlight].map(([destination, value]) => ({
        destination,
        txnId: value.txnId,
        rows: value.rows.slice(),
      })),
    reviewIntents: async () =>
      intentProvider !== null && 'review' in intentProvider
        ? await (intentProvider as ReviewableIntentProvider).review()
        : null,
    pruneIntents: async (destination) =>
      intentProvider !== null && 'prune' in intentProvider
        ? await (intentProvider as ReviewableIntentProvider).prune(destination)
        : null,
    contactHook: () => (origin: string) => {
      void serverP.then((server) => notifyPeerAlive(server, origin)).catch(
        () => {},
      );
      wake(origin);
    },
    setIntentProvider: (provider) => {
      intentProvider = provider;
    },
    stop: async () => {
      stopped = true;
      for (const resolve of wakers.values()) resolve();
      await Promise.all([...loops]);
    },
  };
}
