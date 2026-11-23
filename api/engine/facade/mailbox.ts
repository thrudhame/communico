// Original admission and exact per-child results survive every cross-file cut.
// Room and EDU owners do their own idempotent work outside the server tx; only
// the complete result and its home obligation are committed together here.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  absentTransactionRoom,
  decodeTransaction,
  type PduResults,
  receiveTransactionRoom,
  type TransactionDeps,
  transactionRooms,
  type TxnResult,
} from '#engine/federation/transactions.ts';
import {
  type RequestEvidence,
  verifyRequestEvidence,
} from '#engine/federation/request-evidence.ts';
import { requestCanonical } from '#engine/federation/request-signature.ts';
import { transactionReplayCanonical } from '#engine/federation/transaction-request.ts';
import { openRoom } from '#engine/room/index.ts';
import { exportReplicaRoom, type ReplicaRoom } from '#engine/room/replica.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { appendRecord } from './journal.ts';
import type { NodeIdentity } from './identity.ts';
import type { Pairings } from './pairing.ts';
import { PermanentEduRefusal } from '#engine/federation/edus.ts';
import { eduEnvelope } from '#engine/federation/peer-json.ts';
import { decodeToDevice } from '#engine/federation/todevice.ts';
import { toDeviceMessageHash } from '#engine/tenant/todevice-routing.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

export type IngressRoom = {
  roomId: string;
  result: PduResults;
  recovery: ReplicaRoom | null;
};
export type IngressEdu = { index: number; disposition: unknown };
export type IngressObligation = {
  kind: 'ingress';
  phase?: 'f2';
  txnId: string;
  evidence: RequestEvidence;
  rooms: IngressRoom[];
  edus: IngressEdu[];
  response: TxnResult;
};
type Binding = {
  pairing: string;
  revision: number;
  source: string;
  incarnation: string;
};
type Admission = Binding & {
  phase: 'f1' | 'f2';
  origin: string;
  txnId: string;
  evidence: RequestEvidence;
  response: TxnResult | null;
};

function unavailable(cause?: unknown): MatrixError {
  const error = new MatrixError(
    503,
    'M_UNAVAILABLE',
    'durable federation processing incomplete',
  );
  error.cause = cause;
  return error;
}
function collision(): never {
  throw new MatrixError(
    400,
    'M_BAD_JSON',
    'transaction identity reused with changed signed content',
  );
}
export function ingressOperation(origin: string, txnId: string) {
  return 'ingress:' +
    createHash('sha256').update(canonicalJson([origin, txnId])).digest('hex');
}
export async function verifyIngressRequest(
  txnId: string,
  raw: unknown,
  self: string,
) {
  const { evidence, request } = await verifyRequestEvidence(raw, self);
  const prefix = '/_matrix/federation/v1/send/';
  const path = request.uri.split('?')[0];
  if (
    request.method !== 'PUT' || !path.startsWith(prefix) ||
    decodeURIComponent(path.slice(prefix.length)) !== txnId || !txnId
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'retained request is not this transaction',
    );
  }
  const transaction = decodeTransaction(
    JSON.parse(new TextDecoder().decode(request.body)),
    evidence.origin,
  );
  const canonical = requestCanonical(self, request, evidence.origin);
  const inputHash = createHash('sha256').update(canonical).digest('hex');
  const operationHash = createHash('sha256').update(
    transactionReplayCanonical(canonical),
  ).digest('hex');
  return { evidence, request, transaction, inputHash, operationHash };
}

/** Stored input_hash remains the immutable full original evidence digest.
 * Derive the replay comparison from that authenticated evidence, so old pending
 * and completed receipts need neither replacement nor a digest migration. Both
 * facade admission and home reconciliation use this same comparison. */
export async function sameIngressRequest(
  txnId: string,
  self: string,
  held: Record<string, unknown>,
  incoming: Awaited<ReturnType<typeof verifyIngressRequest>>,
): Promise<boolean> {
  if (held.input_hash === incoming.inputHash) return true;
  let original: Awaited<ReturnType<typeof verifyIngressRequest>>;
  try {
    original = await verifyIngressRequest(
      txnId,
      JSON.parse(String(held.evidence_json)),
      self,
    );
    if (original.inputHash !== held.input_hash) {
      throw new Error('retained evidence digest differs');
    }
  } catch (cause) {
    throw new Error('retained ingress evidence is invalid', { cause });
  }
  return original.operationHash === incoming.operationHash;
}
async function checkBinding(conn: Conn, binding: Binding) {
  const [row] = await conn.query(
    "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
    [binding.pairing],
  );
  if (row?.state !== 'paired' || Number(row.revision) !== binding.revision) {
    throw unavailable();
  }
}

function logicalMessage(origin: string, self: string, raw: unknown) {
  try {
    const { type, content } = eduEnvelope(raw);
    if (type !== 'm.direct_to_device') return null;
    const input = decodeToDevice(origin, self, content);
    return {
      id: input.id,
      hash: toDeviceMessageHash(input.sender, input.type, self, input.messages),
    };
  } catch (error) {
    // Invalid EDUs retain the normal saved refusal, never a logical policy.
    if (error instanceof PermanentEduRefusal) return null;
    if (
      error instanceof UpstreamError &&
      ['protocol', 'validation'].includes(error.category)
    ) return null;
    throw error;
  }
}

/** Recover the first authenticated admission cut, including old pending F1
 * envelopes whose child has never run. Indexing shares the admission tx and
 * never rewrites original evidence, child results or exported records. */
async function indexLogicalPolicies(conn: Conn, self: string) {
  for (
    const row of await conn.query(
      'SELECT * FROM facade_ingress WHERE policies_indexed=0 ORDER BY rowid',
    )
  ) {
    const verified = await verifyIngressRequest(
      String(row.txn_id),
      JSON.parse(String(row.evidence_json)),
      self,
    );
    if (verified.inputHash !== row.input_hash) throw unavailable();
    for (const raw of verified.transaction.edus) {
      const input = logicalMessage(verified.evidence.origin, self, raw);
      if (!input) continue;
      await conn.execute(
        'INSERT INTO facade_ingress_edu_policy(origin,message_id,payload_hash,phase) VALUES(?,?,?,?) ON CONFLICT(origin,message_id) DO NOTHING',
        [verified.evidence.origin, input.id, input.hash, row.ingress_phase],
      );
    }
    await conn.execute(
      'UPDATE facade_ingress SET policies_indexed=1 WHERE origin=? AND txn_id=?',
      [row.origin, row.txn_id],
    );
  }
}

export class Mailbox {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    private readonly db: Database,
    private readonly options: {
      self: string;
      node: NodeIdentity;
      pairings: Pairings;
      transaction: TransactionDeps;
      phase?: 'f1' | 'f2';
      scopeState(
        scope: string,
        signal?: AbortSignal,
      ): Promise<'ready' | 'absent'>;
      acceptEdu(
        origin: string,
        raw: unknown,
        phase: 'f1' | 'f2',
      ): Promise<unknown>;
      changed(): void;
    },
  ) {}

  /** Called by verified authentication, before contact or processing effects. */
  async stage(txnId: string, raw: RequestEvidence): Promise<void> {
    try {
      await this.prepare(txnId, raw);
    } catch (error) {
      if (error instanceof MatrixError) throw error;
      if (error instanceof SyntaxError || error instanceof URIError) {
        throw new MatrixError(
          400,
          'M_BAD_JSON',
          'invalid retained transaction',
        );
      }
      throw unavailable(error);
    }
  }

  private async prepare(txnId: string, raw: RequestEvidence): Promise<void> {
    const verified = await verifyIngressRequest(
      txnId,
      raw,
      this.options.self,
    );
    const { evidence, inputHash } = verified;
    const grant = await this.options.pairings.active();
    const context = grant.body.transcript.body.context;
    const binding = {
      pairing: context.id,
      revision: grant.body.revision,
      source: this.options.node.node,
      incarnation: this.options.node.incarnation,
    };
    const encoded = canonicalJson(evidence);
    const bytes = Buffer.byteLength(encoded);
    const changed = await this.db.tx(async (conn) => {
      await checkBinding(conn, binding);
      await indexLogicalPolicies(conn, this.options.self);
      let logicalCollision = false;
      const incoming = new Map<string, string>();
      for (const raw of verified.transaction.edus) {
        const input = logicalMessage(evidence.origin, this.options.self, raw);
        if (!input) continue;
        if (incoming.has(input.id) && incoming.get(input.id) !== input.hash) {
          logicalCollision = true;
        }
        incoming.set(input.id, input.hash);
        const [policy] = await conn.query(
          'SELECT payload_hash FROM facade_ingress_edu_policy WHERE origin=? AND message_id=?',
          [evidence.origin, input.id],
        );
        if (policy && policy.payload_hash !== input.hash) {
          logicalCollision = true;
        }
      }
      const [held] = await conn.query(
        'SELECT input_hash,evidence_json FROM facade_ingress WHERE origin=? AND txn_id=?',
        [evidence.origin, txnId],
      );
      if (
        !logicalCollision && held && await sameIngressRequest(
          txnId,
          this.options.self,
          held,
          verified,
        )
      ) return false;
      if (
        (held || logicalCollision) && (await conn.query(
          'SELECT 1 FROM facade_ingress_collisions WHERE origin=? AND txn_id=? AND input_hash=?',
          [evidence.origin, txnId, inputHash],
        )).length
      ) {
        return true;
      }
      const max = config().facade.mailboxmaxbytes;
      if (max) {
        const [usage] = await conn.query(
          "SELECT (SELECT COALESCE(SUM(i.bytes),0) FROM facade_ingress i WHERE i.record_hash IS NULL OR NOT EXISTS (SELECT 1 FROM facade_records r WHERE r.peer='home' AND r.direction='out' AND r.source=i.source AND r.incarnation=i.incarnation AND r.hash=i.record_hash AND r.result_json IS NOT NULL)) + (SELECT COALESCE(SUM(length(CAST(evidence_json AS BLOB))),0) FROM facade_ingress_collisions) AS bytes",
        );
        if (Number(usage.bytes) + bytes > max) {
          throw new MatrixError(
            429,
            'M_LIMIT_EXCEEDED',
            'configured mailbox capacity reached',
          );
        }
      }
      if (held || logicalCollision) {
        await conn.execute(
          'INSERT INTO facade_ingress_collisions(origin,txn_id,input_hash,evidence_json) VALUES(?,?,?,?)',
          [evidence.origin, txnId, inputHash, encoded],
        );
        return true;
      }
      await conn.execute(
        'INSERT INTO facade_ingress(origin,txn_id,input_hash,evidence_json,bytes,pairing,revision,source,incarnation,ingress_phase) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          evidence.origin,
          txnId,
          inputHash,
          encoded,
          bytes,
          binding.pairing,
          binding.revision,
          binding.source,
          binding.incarnation,
          this.options.phase ?? 'f1',
        ],
      );
      await indexLogicalPolicies(conn, this.options.self);
      return false;
    });
    if (changed) collision();
  }

  async receive(
    origin: string,
    txnId: string,
    signal?: AbortSignal,
  ): Promise<TxnResult> {
    const key = ingressOperation(origin, txnId);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.locks.set(key, tail);
    await previous;
    try {
      signal?.throwIfAborted();
      return await this.process(origin, txnId, signal);
    } catch (error) {
      if (
        error instanceof MatrixError && [400, 429, 503].includes(error.status)
      ) throw error;
      throw unavailable(error);
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async admission(origin: string, txnId: string): Promise<Admission> {
    const [row] = await this.db.query(
      'SELECT * FROM facade_ingress WHERE origin=? AND txn_id=?',
      [origin, txnId],
    );
    if (!row) throw unavailable();
    return {
      origin,
      txnId,
      phase: row.ingress_phase as Admission['phase'],
      pairing: String(row.pairing),
      revision: Number(row.revision),
      source: String(row.source),
      incarnation: String(row.incarnation),
      evidence: JSON.parse(String(row.evidence_json)),
      response: row.response_json === null
        ? null
        : JSON.parse(String(row.response_json)),
    };
  }

  private async child<T>(
    entry: Admission,
    kind: string,
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const args = [entry.origin, entry.txnId, kind, key];
    const [held] = await this.db.query(
      'SELECT result_json FROM facade_ingress_children WHERE origin=? AND txn_id=? AND kind=? AND child_key=?',
      args,
    );
    if (held) return JSON.parse(String(held.result_json)) as T;
    const result = await run();
    const encoded = canonicalJson(result);
    await this.db.tx(async (conn) => {
      await checkBinding(conn, entry);
      await conn.execute(
        'INSERT INTO facade_ingress_children(origin,txn_id,kind,child_key,result_json) VALUES(?,?,?,?,?)',
        [...args, encoded],
      );
    });
    return JSON.parse(encoded) as T;
  }

  private async process(
    origin: string,
    txnId: string,
    signal?: AbortSignal,
  ): Promise<TxnResult> {
    const entry = await this.admission(origin, txnId);
    if (entry.response) return entry.response;
    await this.db.tx((conn) => checkBinding(conn, entry));
    await this.db.tx((conn) => indexLogicalPolicies(conn, this.options.self));
    const body = JSON.parse(
      Buffer.from(entry.evidence.request.body, 'base64').toString('utf8'),
    );
    const { pdus, edus } = decodeTransaction(body, origin);
    const rooms: IngressRoom[] = [];
    const tail: IngressEdu[] = [];
    const failures: unknown[] = [];
    // A blocked room cannot suppress other room work or the reliable EDU tail.
    const roomJobs = [...transactionRooms(pdus)].map(
      async ([roomId, inputs]) => {
        try {
          const result = await this.child(entry, 'room', roomId, async () => {
            if (
              await this.options.scopeState('room:' + roomId, signal) ===
                'absent'
            ) {
              return {
                roomId,
                result: await absentTransactionRoom(inputs),
                recovery: null,
              };
            }
            const result = await receiveTransactionRoom(
              roomId,
              inputs,
              origin,
              this.options.transaction,
              ingressOperation(origin, txnId) + ':room:' + roomId,
            );
            const room = await openRoom(this.options.transaction.store, roomId);
            return {
              roomId,
              result,
              recovery: await exportReplicaRoom(room, this.options.self, 0),
            };
          });
          rooms.push(result);
        } catch (error) {
          failures.push(new Error('ingress room:' + roomId, { cause: error }));
        }
      },
    );
    const eduJob = (async () => {
      for (const [index, raw] of edus.entries()) {
        try {
          tail.push(
            await this.child(entry, 'edu', String(index), async () => {
              const input = logicalMessage(origin, this.options.self, raw);
              let phase = entry.phase;
              if (input) {
                const [held] = await this.db.query(
                  'SELECT payload_hash,phase FROM facade_ingress_edu_policy WHERE origin=? AND message_id=?',
                  [origin, input.id],
                );
                if (!held) throw unavailable();
                if (held.payload_hash !== input.hash) {
                  return {
                    index,
                    disposition: {
                      kind: 'refused',
                      type: 'm.direct_to_device',
                      errcode: 'M_BAD_JSON',
                      error: 'to-device operation identity changed',
                    },
                  };
                }
                phase = held.phase as Admission['phase'];
              }
              return {
                index,
                disposition: await this.options.acceptEdu(origin, raw, phase),
              };
            }),
          );
        } catch (error) {
          failures.push(new Error('ingress EDU:' + index, { cause: error }));
        }
      }
    })();
    await Promise.all([...roomJobs, eduJob]);
    if (failures.length) {
      throw unavailable(
        new AggregateError(failures, 'durable ingress children failed'),
      );
    }
    // Completion order is not semantic input. Pin a deterministic whole answer.
    rooms.sort((a, b) =>
      a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0
    );
    const results: PduResults = {};
    for (const room of rooms) Object.assign(results, room.result);
    const response: TxnResult = { status: 200, body: { pdus: results } };
    // A later F1 transaction can retry an earlier F2 logical message. The
    // immutable child contract, not that later transaction's phase, owns drain.
    const phase =
      tail.some(({ disposition }) =>
          typeof disposition === 'object' &&
          disposition !== null && 'kind' in disposition &&
          disposition.kind === 'routed'
        )
        ? 'f2'
        : entry.phase;
    const payload: IngressObligation = {
      kind: 'ingress',
      ...(phase === 'f2' ? { phase: 'f2' as const } : {}),
      txnId,
      evidence: entry.evidence,
      rooms,
      edus: tail,
      response,
    };
    await this.db.tx(async (conn) => {
      await checkBinding(conn, entry);
      const record = await appendRecord(conn, 'home', {
        source: entry.source,
        incarnation: entry.incarnation,
        stream: 'ingress:' + origin,
        type: 'ingress',
        version: phase === 'f2'
          ? edus.some((raw) => logicalMessage(origin, this.options.self, raw))
            ? 3
            : 2
          : 1,
        operationId: ingressOperation(origin, txnId),
        payload,
      });
      await conn.execute(
        'UPDATE facade_ingress SET response_json=?,record_sequence=?,record_hash=? WHERE origin=? AND txn_id=? AND response_json IS NULL',
        [canonicalJson(response), record.sequence, record.hash, origin, txnId],
      );
    });
    this.options.changed();
    return response;
  }
}
