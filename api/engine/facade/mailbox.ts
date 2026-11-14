// Original admission and exact per-child results survive every cross-file cut.
// Room and EDU owners do their own idempotent work outside the server tx; only
// the complete result and its home obligation are committed together here.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
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
import { openRoom } from '#engine/room/index.ts';
import { exportReplicaRoom, type ReplicaRoom } from '#engine/room/replica.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { appendRecord } from './journal.ts';
import type { NodeIdentity } from './identity.ts';
import type { Pairings } from './pairing.ts';

export type IngressRoom = {
  roomId: string;
  result: PduResults;
  recovery: ReplicaRoom;
};
export type IngressEdu = { index: number; disposition: unknown };
export type IngressObligation = {
  kind: 'ingress';
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
  const inputHash = createHash('sha256').update(
    requestCanonical(self, request, evidence.origin),
  ).digest('hex');
  return { evidence, request, transaction, inputHash };
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

export class Mailbox {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    private readonly db: Database,
    private readonly options: {
      self: string;
      node: NodeIdentity;
      pairings: Pairings;
      transaction: TransactionDeps;
      requireScope(scope: string): Promise<void>;
      acceptEdu(origin: string, raw: unknown): Promise<unknown>;
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
    const { evidence, inputHash } = await verifyIngressRequest(
      txnId,
      raw,
      this.options.self,
    );
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
      const [held] = await conn.query(
        'SELECT input_hash FROM facade_ingress WHERE origin=? AND txn_id=?',
        [evidence.origin, txnId],
      );
      if (held) {
        if (held.input_hash === inputHash) return false;
        await conn.execute(
          'INSERT INTO facade_ingress_collisions(origin,txn_id,input_hash,evidence_json) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
          [evidence.origin, txnId, inputHash, encoded],
        );
        return true;
      }
      const max = config().facade.mailboxmaxbytes;
      if (max) {
        const [usage] = await conn.query(
          "SELECT COALESCE(SUM(i.bytes),0) AS bytes FROM facade_ingress i WHERE i.record_hash IS NULL OR NOT EXISTS (SELECT 1 FROM facade_records r WHERE r.peer='home' AND r.direction='out' AND r.source=i.source AND r.incarnation=i.incarnation AND r.hash=i.record_hash AND r.result_json IS NOT NULL)",
        );
        if (Number(usage.bytes) + bytes > max) {
          throw new MatrixError(
            429,
            'M_LIMIT_EXCEEDED',
            'configured mailbox capacity reached',
          );
        }
      }
      await conn.execute(
        'INSERT INTO facade_ingress(origin,txn_id,input_hash,evidence_json,bytes,pairing,revision,source,incarnation) VALUES(?,?,?,?,?,?,?,?,?)',
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
        ],
      );
      return false;
    });
    if (changed) collision();
  }

  async receive(origin: string, txnId: string): Promise<TxnResult> {
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
      return await this.process(origin, txnId);
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

  private async process(origin: string, txnId: string): Promise<TxnResult> {
    const entry = await this.admission(origin, txnId);
    if (entry.response) return entry.response;
    await this.db.tx((conn) => checkBinding(conn, entry));
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
            await this.options.requireScope('room:' + roomId);
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
          failures.push(error);
        }
      },
    );
    const eduJob = (async () => {
      for (const [index, raw] of edus.entries()) {
        try {
          tail.push(
            await this.child(entry, 'edu', String(index), async () => ({
              index,
              disposition: await this.options.acceptEdu(origin, raw),
            })),
          );
        } catch (error) {
          failures.push(error);
        }
      }
    })();
    await Promise.all([...roomJobs, eduJob]);
    if (failures.length) throw unavailable(failures[0]);
    // Completion order is not semantic input. Pin a deterministic whole answer.
    rooms.sort((a, b) =>
      a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0
    );
    const results: PduResults = {};
    for (const room of rooms) Object.assign(results, room.result);
    const response: TxnResult = { status: 200, body: { pdus: results } };
    const payload: IngressObligation = {
      kind: 'ingress',
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
        version: 1,
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
