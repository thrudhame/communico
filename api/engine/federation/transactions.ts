// api/engine/federation/transactions.ts — inbound transactions (§3.3):
// the function behind PUT /_matrix/federation/v1/send/{txnId} (routing is
// stage 5). Decide first, then answer (design point D): every PDU goes
// through 3c's ingestRemote — per-room grouping, one room at a time
// (sequentially per room; the room lock lives inside ingestRemote) — and
// the 200's `pdus` carries the real outcome for every PDU that had a
// computable id (transactions.yaml:61-91; a {} entry means "successfully
// handled" — rejection is not a transaction error, SS:565-566). The
// replay cache (federation_txns, pruned on insert after txnhours) gives
// a retried transaction the same answer — a cache, not an obligation.
// EDUs ride after PDUs to their registered handlers.
import { config } from '#engine/config.ts';
import { transactionRequest } from './transaction-request.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import type { Fetcher, KeyResolver, RemoteDeps } from '#engine/room/deps.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import type { CommitWait } from '#engine/room/ingest.ts';
import {
  ingestRemote,
  type RemoteOutcome,
  replayRemoteBatch,
} from '#engine/room/remote.ts';
import type { Store } from '#engine/store/index.ts';
import { ReliableEduError } from '#engine/federation/edus.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import type { RequestEvidence } from './request-evidence.ts';
import {
  type DemandedWork,
  demandedWork,
  joinDemand,
} from '#engine/net/demand.ts';

export type TransactionDeps = {
  store: Store;
  keys: KeyResolver;
  fetcher: Fetcher;
  // our own server name (the delivering server's events never fan back)
  self: string;
  edus: {
    dispatch(origin: string, raw: unknown, required?: boolean): Promise<void>;
  };
  // a leave/ban for a user with an out-of-band invite is a remote
  // rejection (invites.ts, 4c-2 commit 4 — wired when it lands)
  rescind?: (roomId: string, pdu: Pdu) => Promise<boolean>;
};

export type TxnResult = { status: number; body: Record<string, unknown> };
export type TransactionIngress = {
  stage(txnId: string, evidence: RequestEvidence): Promise<void>;
  receive(
    origin: string,
    txnId: string,
    signal?: AbortSignal,
  ): Promise<TxnResult>;
};
export type PduResults = Record<
  string,
  Record<string, never> | { error: string }
>;

async function identifyRoomInputs(
  pdus: Pdu[],
  version: string,
  signal?: AbortSignal,
) {
  const identified: { pdu: Pdu; eventId: string }[] = [];
  for (const pdu of pdus) {
    signal?.throwIfAborted();
    let eventId: string;
    try {
      eventId = await eventIdFor(
        pdu as unknown as Record<string, unknown>,
        version,
      );
    } catch {
      continue;
    }
    pdu.event_id = eventId;
    identified.push({ pdu, eventId });
  }
  return identified;
}

/** No room/DAG authority is implied by an out-of-band invite. The local invite
 * owner may still process its ordinary rescind without creating a room. */
export async function absentTransactionRoom(
  pdus: Pdu[],
  rescind?: (pdu: Pdu) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<PduResults> {
  const results: PduResults = {};
  for (const { pdu, eventId } of await identifyRoomInputs(pdus, '11', signal)) {
    signal?.throwIfAborted();
    results[eventId] = rescind && await rescind(pdu)
      ? {}
      : { error: 'unknown room' };
  }
  return results;
}

/** Shared envelope admission for standalone processing and durable ingress. */
export function decodeTransaction(rawBody: unknown, origin: string) {
  try {
    return transactionRequest(rawBody, origin);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    const failure = new MatrixError(
      400,
      error.context.resourceLimit ? 'M_TOO_LARGE' : 'M_BAD_JSON',
      error.context.reason,
    );
    failure.cause = error;
    throw failure;
  }
}

export function transactionRooms(pdus: readonly Pdu[]) {
  const byRoom = new Map<string, Pdu[]>();
  for (const raw of pdus) {
    const pdu = raw as unknown as Pdu;
    let roomId = typeof pdu.room_id === 'string' ? pdu.room_id : null;
    if (
      roomId === null && pdu.type === 'm.room.create' &&
      typeof pdu.event_id === 'string'
    ) roomId = '!' + String(pdu.event_id).slice(1);
    if (roomId === null) continue;
    const held = byRoom.get(roomId);
    const list = held == null ? [] : held;
    list.push(pdu);
    byRoom.set(roomId, list);
  }
  return byRoom;
}

export async function dispatchTransactionEdu(
  origin: string,
  raw: unknown,
  edus: TransactionDeps['edus'],
  required = false,
): Promise<void> {
  try {
    await edus.dispatch(origin, raw, required);
  } catch (error) {
    if (error instanceof ReliableEduError) throw error;
    if (
      !(error instanceof UpstreamError) ||
      !['protocol', 'validation'].includes(error.category)
    ) throw error;
    console.error(`transactions[${origin}]: EDU dropped:`, error);
  }
}

export async function receiveTransactionRoom(
  roomId: string,
  pdus: Pdu[],
  origin: string,
  deps: TransactionDeps,
  operationId?: string,
  signal?: AbortSignal,
  completion: CommitWait = 'published',
): Promise<PduResults> {
  signal?.throwIfAborted();
  const fed = config().federation;
  const results: PduResults = {};
  await receiveRoom(
    roomId,
    pdus,
    origin,
    deps,
    {
      keys: deps.keys,
      fetcher: deps.fetcher,
      self: deps.self,
      signal,
      completion,
      limits: {
        waitMs: fed.missingwaitms,
        limit: fed.missinglimit,
        budgetMs: fed.missingbudgetms,
      },
      ungroundedMs: fed.ungroundedmillihours * 3_600,
    },
    results,
    operationId,
  );
  return results;
}

// One room's PDUs through the remote pipeline, mapping outcomes to the
// spec's per-PDU result entries ({} for handled — accepted, rejected,
// soft-failed, known, pending-ungrounded — { error } for dropped and
// refused; uncomputable ids get no entry). Room-level failures answer
// per PDU: 'unknown room' (or the rescind's acceptance) and
// 'not participating' (§3.6a — a membership fact, the stay is closed).
async function receiveRoom(
  roomId: string,
  pdus: Pdu[],
  origin: string,
  deps: TransactionDeps,
  remoteDeps: RemoteDeps,
  results: PduResults,
  operationId?: string,
): Promise<void> {
  remoteDeps.signal?.throwIfAborted();
  let room: Room | null = null;
  try {
    room = await openRoom(deps.store, roomId);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  // the room's version (for the result keys) and participation, one read
  let version = '11';
  let participating = false;
  if (room !== null) {
    const read = await room.tx(async (tx) => {
      const stay = await tx.segments.latestStay();
      if (stay === null) return { version: null, participating: false };
      return {
        version: await roomVersionOf(tx, stay.id),
        participating: stay.status === 'open',
      };
    });
    version = read.version == null ? '11' : read.version;
    participating = read.participating;
  }
  if (room === null) {
    Object.assign(
      results,
      await absentTransactionRoom(
        pdus,
        deps.rescind ? (pdu) => deps.rescind!(roomId, pdu) : undefined,
        remoteDeps.signal,
      ),
    );
    return;
  }
  // the result key is the event's COMPUTED id (uncomputable → no entry —
  // Complement counts them, federation_room_get_missing_events_test.go:292-294)
  // Restore derived event IDs on the wire form before shared remote admission.
  const identified = await identifyRoomInputs(pdus, version, remoteDeps.signal);
  if (operationId !== undefined) {
    const prior = await replayRemoteBatch(
      room,
      identified.map((item) => item.pdu),
      origin,
      deps.self,
      operationId,
      'pushed',
      remoteDeps.signal,
      remoteDeps.completion,
    );
    if (prior) {
      assignOutcomes(results, prior);
      return;
    }
  }
  if (!participating) {
    for (const { eventId } of identified) {
      results[eventId] = { error: 'not participating' };
    }
    return;
  }
  const outcomes = await ingestRemote(
    room,
    identified.map((item) => item.pdu),
    origin,
    remoteDeps,
    'pushed',
    operationId,
  );
  assignOutcomes(results, outcomes);
}

function assignOutcomes(results: PduResults, outcomes: RemoteOutcome[]) {
  for (const outcome of outcomes) {
    if (outcome.eventId === null) continue;
    switch (outcome.outcome) {
      case 'accepted':
      case 'rejected':
      case 'soft_failed':
      case 'known':
        // handled — rejection is NOT a transaction error (SS:565-566)
        results[outcome.eventId] = {};
        break;
      case 'pending':
        results[outcome.eventId] = outcome.error === null
          ? {}
          : { error: outcome.error };
        break;
      case 'dropped':
      case 'refused':
        results[outcome.eventId] = {
          error: outcome.error == null ? outcome.outcome : outcome.error,
        };
        break;
    }
  }
}

// Standalone ingress owns one active operation per authenticated transaction.
// Completed answers remain durable; a failed operation releases its identity so
// a later retry can try again. Store identity prevents cross-install sharing.
const activeTransactions = new WeakMap<
  Store,
  Map<string, DemandedWork<TxnResult>>
>();

export async function receiveTransaction(
  origin: string,
  txnId: string,
  rawBody: unknown,
  deps: TransactionDeps,
  signal?: AbortSignal,
): Promise<TxnResult> {
  signal?.throwIfAborted();
  // Even a retry must pass envelope admission before joining an existing result.
  const input = decodeTransaction(rawBody, origin);
  let active = activeTransactions.get(deps.store);
  if (active === undefined) {
    active = new Map();
    activeTransactions.set(deps.store, active);
  }
  const key = JSON.stringify([origin, txnId]);
  let pending = active.get(key);
  if (pending?.abort.signal.aborted) {
    // The old callback may still own a native transaction or projection. A new
    // retry cannot overlap it merely because its transport disappeared.
    try {
      await pending.run;
    } catch { /* Subscribers retain the old result. */ }
    signal?.throwIfAborted();
    return await receiveTransaction(origin, txnId, rawBody, deps, signal);
  }
  if (pending === undefined) {
    pending = demandedWork((demand) =>
      receiveOwnedTransaction(origin, txnId, input, deps, demand)
    );
    active.set(key, pending);
    const owned = pending;
    void pending.run.finally(() => {
      if (active.get(key) === owned) active.delete(key);
    }).catch(() => {}); // Subscribers observe the original callback's failure.
  }
  // Subscribers own their response values, not the operation's shared object.
  return structuredClone(await joinDemand(pending, signal));
}

async function receiveOwnedTransaction(
  origin: string,
  txnId: string,
  { pdus, edus }: ReturnType<typeof decodeTransaction>,
  deps: TransactionDeps,
  signal: AbortSignal,
): Promise<TxnResult> {
  signal.throwIfAborted();
  const server = await deps.store.server();
  // replay: a retried transaction gets the stored answer
  const cached = await server.query(
    'SELECT response FROM federation_txns WHERE origin = ? AND txn_id = ?',
    [origin, txnId],
  );
  if (cached.length > 0) {
    return {
      status: 200,
      body: JSON.parse(String(cached[0].response)) as Record<string, unknown>,
    };
  }

  const fed = config().federation;
  const results: PduResults = {};
  // one room at a time, in first-seen order (the room's own sequencing
  // lives inside ingestRemote's locked batch)
  for (const [roomId, roomPdus] of transactionRooms(pdus)) {
    signal.throwIfAborted();
    Object.assign(
      results,
      await receiveTransactionRoom(
        roomId,
        roomPdus,
        origin,
        deps,
        undefined,
        signal,
        // The answer reports decided, durably accepted outcomes. Publication
        // is the store owner's committed obligation, recovered after restart;
        // consumers needing published state wait on their own obligation.
        'accepted',
      ),
    );
  }

  // Reliable acceptance must finish before the transport success is cached.
  for (const raw of edus) {
    signal.throwIfAborted();
    await dispatchTransactionEdu(origin, raw, deps.edus);
  }

  const response = { pdus: results };
  signal.throwIfAborted();
  // the replay cache — pruned on insert after txnhours
  await server.tx(async (tx) => {
    signal.throwIfAborted();
    await tx.execute(
      'DELETE FROM federation_txns WHERE received_ms < ?',
      [Date.now() - fed.txnhours * 3_600_000],
    );
    await tx.execute(
      'INSERT INTO federation_txns(origin, txn_id, received_ms, response) VALUES(?,?,?,?) ON CONFLICT(origin, txn_id) DO UPDATE SET received_ms = excluded.received_ms, response = excluded.response',
      [origin, txnId, Date.now(), JSON.stringify(response)],
    );
  });
  return { status: 200, body: response };
}
