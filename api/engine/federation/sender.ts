// One destination loop owns room delivery, reliable EDUs and the peer ladder.
// Persist the exact mixed envelope before transport; retry its bytes and id
// across restart. Only PDU work uses refusedmillihours expiry. A changed PDU
// selection retires its envelope without expiring accepted reliable messages.
import { config } from '#engine/config.ts';
import { encodeEnvelope } from '#engine/federation-envelope.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom } from '#engine/room/index.ts';
import type { Signer } from '#engine/room/signer.ts';
import { onProjected } from '#engine/server/project.ts';
import { outboxDue, type OutboxDueRow } from '#engine/server/read.ts';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import {
  completeBatch,
  deliveryTurn,
  type Dispatch,
  type DispatchEnvelope,
  freezeBatch,
  frozenBatch,
  pendingEdus,
} from '#engine/server/delivery.ts';
import { FederationHttpError, federationRequest } from './client.ts';
import { sendVerdicts } from './responses.ts';
import { protocol, upstreamCategory } from '#engine/net/upstream-error.ts';
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
    "SELECT destination FROM outbox WHERE state='pending' UNION SELECT destination FROM edu_outbox WHERE state='pending' UNION SELECT destination FROM federation_batches",
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
  expiresMs: number | null;
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
  onDelivered?: () => Promise<void>;
  // Enrolled homes must coordinate the same frozen owner, not run a second
  // sender. The callback returns only after durable destination completion.
  dispatch?: Dispatch;
};

export async function dispatchBatch(
  server: Db,
  signer: Signer,
  envelope: DispatchEnvelope,
): Promise<unknown> {
  const res = await federationRequest(server, signer, {
    destination: envelope.destination,
    method: 'PUT',
    path: `/_matrix/federation/v1/send/${encodeURIComponent(envelope.txnId)}`,
    body: new TextEncoder().encode(envelope.body),
    maxBytes: config().federation.bulkmaxbytes,
  });
  if (res.status !== 200) protocol('send-verdict', 'expected HTTP 200');
  return { pdus: sendVerdicts(res.json) };
}

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

export function startSender(deps: SenderDeps): Sender {
  const serverP = deps.store.server();
  const running = new Set<string>();
  const rerun = new Set<string>();
  const wakers = new Map<string, () => void>();
  const inFlight = new Map<string, { txnId: string; rows: string[] }>();
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
    if (running.has(destination)) rerun.add(destination);
    if (!running.has(destination) && !stopped) {
      rerun.delete(destination);
      running.add(destination);
      const loop = loopDestination(destination)
        .catch(async (e) => {
          console.error(`sender[${destination}] error:`, e);
          if (upstreamCategory(e) === 'local' && !stopped) {
            // Durable work remains owned after local signer/store faults. Retry
            // separately from the peer ladder, retaining the frozen envelope.
            await sleep(1000, destination);
            rerun.add(destination);
          }
        })
        .finally(() => {
          running.delete(destination);
          loops.delete(loop);
          // A producer can wake after the final empty read but before this
          // finally runs. Latch that wake rather than stranding durable work.
          if (rerun.delete(destination) && !stopped) wake(destination);
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
      if (['local', 'cancellation'].includes(upstreamCategory(e))) throw e;
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
    let retryTxn: string | undefined;
    let quickAttempts = 0;
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
      // Resume exact persisted bytes first. New work cannot change an in-flight
      // transaction, even when it arrives between a failure and a restart.
      let frozen = await frozenBatch(
        server,
        destination,
        deps.dispatch !== undefined,
      );
      if (frozen === null) {
        const candidates = await outboxDue(server, destination, Date.now(), 50);
        const pending = await pendingEdus(server, destination, 100);
        const rows: OutboxDueRow[] = [];
        const reliable: typeof pending = [];
        const edus: Edu[] = [];
        const pdus: Record<string, unknown>[] = [];
        if (stopped) return;
        // Reliable and room work get independent slots in every envelope. The
        // byte budget leaves room for both before draining ephemeral extras.
        const maxBytes = config().federation.bulkmaxbytes;
        const ts = Date.now();
        const encode = () =>
          encodeEnvelope(deps.signer.serverName, ts, pdus, edus);
        // Alternate the first family durably, then interleave candidates. A
        // large PDU and an EDU that cannot fit together each get their turn.
        const eduFirst = (await deliveryTurn(server, destination)) % 2 === 1;
        let reliableBlocked = false;
        for (let i = 0; i < Math.max(candidates.length, pending.length); i++) {
          for (const family of eduFirst ? ['edu', 'pdu'] : ['pdu', 'edu']) {
            if (family === 'pdu' && i < candidates.length) {
              const row = candidates[i];
              const pdu = await pduOf(row.room, row.event);
              if (pdu !== null) pdus.push(pdu);
              if (new TextEncoder().encode(encode()).length <= maxBytes) {
                rows.push(row);
              } else if (pdu !== null) pdus.pop();
            } else if (
              family === 'edu' && !reliableBlocked && i < pending.length
            ) {
              const row = pending[i];
              edus.push({ edu_type: row.edu_type, content: row.content });
              if (new TextEncoder().encode(encode()).length <= maxBytes) {
                reliable.push(row);
              } else {
                edus.pop();
                reliableBlocked = true;
              }
            }
          }
        }
        if (
          rows.length === 0 && reliable.length === 0 &&
          (candidates.length || pending.length)
        ) {
          throw new Error('individual federation work exceeds envelope budget');
        }
        const extras = deps.drainEdus === undefined
          ? []
          : deps.drainEdus(destination, 100 - edus.length);
        for (const edu of extras) {
          edus.push(edu);
          if (new TextEncoder().encode(encode()).length > maxBytes) {
            edus.pop();
          }
        }
        if (rows.length === 0 && edus.length === 0) return;
        const body = encode();
        if (new TextEncoder().encode(body).length > maxBytes) {
          throw new Error('federation envelope exceeds byte budget');
        }
        frozen = {
          txnId: crypto.randomUUID(),
          body,
          rows,
          sources: reliable.map((r) => r.source),
        };
        if (!await freezeBatch(server, destination, frozen)) continue;
      }
      if (stopped) return;
      const delivered = frozen;
      const { txnId, rows: batch } = delivered;
      if (retryTxn !== txnId) {
        retryTxn = txnId;
        quickAttempts = 0;
      }
      let verdicts: ReturnType<typeof sendVerdicts>;
      try {
        inFlight.set(destination, {
          txnId,
          rows: batch.map((row) => `${row.room}:${row.pos}`),
        });
        const envelope = { destination, txnId, body: delivered.body };
        const response = deps.dispatch
          ? await deps.dispatch(envelope)
          : await dispatchBatch(server, deps.signer, envelope);
        verdicts = sendVerdicts(response);
      } catch (e) {
        const category = upstreamCategory(e);
        // A local signer/store/programming fault is not a peer outage. Abort is
        // control flow, not evidence for backoff. Completed HTTP keeps status.
        if (
          !(e instanceof FederationHttpError) &&
          (category === 'local' || category === 'cancellation')
        ) throw e;
        const err = e as {
          status?: number;
          errcode?: string;
          message?: string;
        };
        // A short outage should not immediately enter the many-minute peer
        // ladder. Only this idempotent frozen transaction retries here: claims
        // and other consuming federation requests remain strictly one-shot.
        // Transactions need a reboot-sized window, unlike interactive key
        // requests. Use the initial transaction retry intervals (4/16s), then
        // publish the configured durable ladder. Restart retains the exact batch.
        const transient = err.status === undefined || err.status === 429 ||
          err.status >= 500;
        if (!stopped && transient && quickAttempts < 2) {
          const until = Date.now() + 4000 * 4 ** quickAttempts++;
          inFlight.delete(destination);
          // Producer wakes cannot accelerate retries. Stop can interrupt this
          // wait; expiry and blocks are rechecked at the normal loop boundary.
          while (!stopped && Date.now() < until) {
            await sleep(until - Date.now(), destination);
          }
          continue;
        }
        quickAttempts = 0;
        const now = Date.now();
        await server.tx(async (tx) => {
          const fresh = await peerStatus(tx, destination);
          const backoff = backoffMs(fresh.failures + 1);
          await recordFailure(
            tx,
            destination,
            `${err.status == null ? category : err.status} ${
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
        await completeBatch(tx, destination, delivered);
        await recordSuccess(tx, destination);
      });
      await deps.onDelivered?.();
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
  function rescan(store: Store): void {
    if (store !== deps.store || stopped) return;
    void serverP.then((server) =>
      destinationsWithPending(server).then((ds) => {
        for (const d of ds) wake(d);
      })
    ).catch(() => {});
  }
  const unproject = onProjected(rescan);
  const untenant = onTenantStream(rescan);

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
      unproject();
      untenant();
      for (const resolve of wakers.values()) resolve();
      await Promise.all([...loops]);
    },
  };
}
