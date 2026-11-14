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
import {
  ingestRemote,
  type RemoteOutcome,
  replayRemoteBatch,
} from '#engine/room/remote.ts';
import type { Store } from '#engine/store/index.ts';
import { ReliableEduError } from '#engine/federation/edus.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import type { RequestEvidence } from './request-evidence.ts';

export type TransactionDeps = {
  store: Store;
  keys: KeyResolver;
  fetcher: Fetcher;
  // our own server name (the delivering server's events never fan back)
  self: string;
  edus: { dispatch(origin: string, raw: unknown): Promise<void> };
  // a leave/ban for a user with an out-of-band invite is a remote
  // rejection (invites.ts, 4c-2 commit 4 — wired when it lands)
  rescind?: (roomId: string, pdu: Pdu) => Promise<boolean>;
};

export type TxnResult = { status: number; body: Record<string, unknown> };
export type TransactionIngress = {
  stage(txnId: string, evidence: RequestEvidence): Promise<void>;
  receive(origin: string, txnId: string): Promise<TxnResult>;
};
export type PduResults = Record<
  string,
  Record<string, never> | { error: string }
>;

async function identifyRoomInputs(pdus: Pdu[], version: string) {
  const identified: { pdu: Pdu; eventId: string }[] = [];
  for (const pdu of pdus) {
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

/** A confirmed absent room has the ordinary per-PDU negative result, not a
 * replica miss or permission to create/ingest an unsolicited room. */
export async function absentTransactionRoom(pdus: Pdu[]): Promise<PduResults> {
  return Object.fromEntries((await identifyRoomInputs(pdus, '11')).map(
    ({ eventId }) => [eventId, { error: 'unknown room' }],
  ));
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
): Promise<void> {
  try {
    await edus.dispatch(origin, raw);
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
): Promise<PduResults> {
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
  // the result key is the event's COMPUTED id (uncomputable → no entry —
  // Complement counts them, federation_room_get_missing_events_test.go:292-294)
  // Restore derived event IDs on the wire form before shared remote admission.
  const identified = await identifyRoomInputs(pdus, version);
  if (room === null) {
    // no room file — except an m.room.member leave/ban for a user with
    // an out-of-band invite (§3.8 step 7's rescind): a remote rejection,
    // not an error
    for (const { pdu, eventId } of identified) {
      if (deps.rescind !== undefined && (await deps.rescind(roomId, pdu))) {
        results[eventId] = {};
      } else {
        results[eventId] = { error: 'unknown room' };
      }
    }
    return;
  }
  if (operationId !== undefined) {
    const prior = await replayRemoteBatch(
      room,
      identified.map((item) => item.pdu),
      origin,
      deps.self,
      operationId,
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

export async function receiveTransaction(
  origin: string,
  txnId: string,
  rawBody: unknown,
  deps: TransactionDeps,
): Promise<TxnResult> {
  const { pdus, edus } = decodeTransaction(rawBody, origin);

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
    Object.assign(
      results,
      await receiveTransactionRoom(roomId, roomPdus, origin, deps),
    );
  }

  // Reliable acceptance must finish before the transport success is cached.
  for (const raw of edus) {
    await dispatchTransactionEdu(origin, raw, deps.edus);
  }

  const response = { pdus: results };
  // the replay cache — pruned on insert after txnhours
  await server.tx(async (tx) => {
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
