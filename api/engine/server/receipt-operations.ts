// Receipt intent belongs to the server receipt transaction. These immutable
// facts use the existing domain journal, but NEVER its register winner: read
// authority is the union of authenticated DAG marks, not a source/clock order.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf } from '#engine/ids.ts';
import type { Conn } from '#engine/store/db.ts';

type Source = { source: string; incarnation: string };
type Dot = Source & { sequence: number };
export type ReceiptMark = {
  roomId: string;
  userId: string;
  receiptType: 'm.read' | 'm.read.private';
  threadId: string | null;
  eventIds: string[];
  ts: number;
  admission: { membershipEvent: string };
};
export type ReceiptOperation = Dot & {
  operationId: string;
  stream: string;
  semanticKey: string;
  kind: 'receipt';
  context: Dot[];
  payloadHash: string;
  payload: string;
};

function digest(payload: string) {
  return createHash('sha256').update(payload).digest('hex');
}
function key(mark: ReceiptMark) {
  return JSON.stringify([
    'receipt',
    mark.roomId,
    mark.userId,
    mark.receiptType,
    mark.threadId,
  ]);
}
function id(dot: Dot, stream: string) {
  return JSON.stringify([dot.source, dot.incarnation, stream, dot.sequence]);
}
function domain(dot: Source) {
  return JSON.stringify([dot.source, dot.incarnation]);
}
function validDot(dot: Dot) {
  return typeof dot?.source === 'string' && /^[\x21-\x7e]+$/.test(dot.source) &&
    typeof dot.incarnation === 'string' &&
    /^[\x21-\x7e]+$/.test(dot.incarnation) &&
    Number.isSafeInteger(dot.sequence) && dot.sequence > 0;
}

export function receiptOperationMark(operation: ReceiptOperation): ReceiptMark {
  let mark: ReceiptMark;
  try {
    mark = JSON.parse(operation.payload);
  } catch {
    throw new Error('invalid receipt operation');
  }
  if (
    !mark || typeof mark.roomId !== 'string' ||
    !/^!\S+:\S+$/.test(mark.roomId) ||
    typeof mark.userId !== 'string' || !/^@\S+:\S+$/.test(mark.userId) ||
    !['m.read', 'm.read.private'].includes(mark.receiptType) ||
    !(mark.threadId === null || mark.threadId === 'main' ||
      (typeof mark.threadId === 'string' && /^\$\S+$/.test(mark.threadId) &&
        new TextEncoder().encode(mark.threadId).length <= 255)) ||
    !Array.isArray(mark.eventIds) || !mark.eventIds.length ||
    !mark.eventIds.every((event) =>
      typeof event === 'string' && /^\$\S+$/.test(event)
    ) ||
    !Number.isSafeInteger(mark.ts) || mark.ts < 0 ||
    typeof mark.admission?.membershipEvent !== 'string' ||
    !/^\$\S+$/.test(mark.admission.membershipEvent)
  ) throw new Error('invalid receipt admission');
  const normalized: ReceiptMark = {
    roomId: mark.roomId,
    userId: mark.userId,
    receiptType: mark.receiptType,
    threadId: mark.threadId,
    eventIds: [...new Set(mark.eventIds)].sort(),
    ts: mark.ts,
    admission: { membershipEvent: mark.admission.membershipEvent },
  };
  if (
    operation.kind !== 'receipt' || !validDot(operation) ||
    operation.semanticKey !== key(normalized) ||
    operation.stream !== 'receipts:' + operation.semanticKey ||
    operation.operationId !== id(operation, operation.stream) ||
    canonicalJson(normalized) !== operation.payload ||
    digest(operation.payload) !== operation.payloadHash ||
    !Array.isArray(operation.context)
  ) throw new Error('invalid receipt operation');
  const seen = new Set<string>();
  for (const dot of operation.context) {
    if (
      !validDot(dot) || seen.has(domain(dot)) ||
      (domain(dot) === domain(operation) &&
        dot.sequence >= operation.sequence) ||
      canonicalJson(dot) !== canonicalJson({
          source: dot.source,
          incarnation: dot.incarnation,
          sequence: dot.sequence,
        })
    ) throw new Error('invalid receipt context');
    seen.add(domain(dot));
  }
  if (
    canonicalJson(operation) !== canonicalJson({
      operationId: operation.operationId,
      source: operation.source,
      incarnation: operation.incarnation,
      stream: operation.stream,
      sequence: operation.sequence,
      semanticKey: operation.semanticKey,
      kind: operation.kind,
      context: operation.context,
      payloadHash: operation.payloadHash,
      payload: operation.payload,
    })
  ) throw new Error('unexpected receipt operation material');
  return normalized;
}

function fromRow(row: Record<string, unknown>): ReceiptOperation {
  return {
    operationId: String(row.operation_id),
    source: String(row.source),
    incarnation: String(row.incarnation),
    stream: String(row.stream),
    sequence: Number(row.sequence),
    semanticKey: String(row.semantic_key),
    kind: 'receipt',
    context: JSON.parse(String(row.context_json)),
    payloadHash: String(row.payload_hash),
    payload: String(row.payload_json),
  };
}

export async function receiptOperations(conn: Conn, userId: string) {
  return (await conn.query(
    "SELECT * FROM domain_operations WHERE kind='receipt' AND json_extract(payload_json,'$.userId')=? ORDER BY source,incarnation,stream,sequence",
    [userId],
  )).map(fromRow);
}

async function control(conn: Conn) {
  const [row] = await conn.query(
    'SELECT c.signed_json,p.node FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision CROSS JOIN publication_domain p WHERE p.singleton=1',
  );
  if (!row) return null;
  const body = JSON.parse(String(row.signed_json)).body;
  return {
    server: String(body.server),
    nodes: body.nodes as { node: string; incarnation: string }[],
    node: String(row.node),
  };
}

/** The caller's authenticated source is supplied by the grant-bound link
 * adapter, never inferred from untrusted operation contents. Retain original
 * admission after departure; receiver disclosure is a separate projection. */
export async function acceptReceiptOperation(
  conn: Conn,
  operation: ReceiptOperation,
  authenticated: Source,
): Promise<boolean> {
  const mark = receiptOperationMark(operation), held = await control(conn);
  const allowed = (dot: Source) =>
    held?.nodes.some((node) =>
      node.node === dot.source && node.incarnation === dot.incarnation
    );
  if (
    !held || domainOf(mark.userId) !== held.server ||
    !allowed(operation) || !operation.context.every(allowed) ||
    operation.source !== authenticated.source ||
    operation.incarnation !== authenticated.incarnation
  ) throw new Error('receipt source unavailable');
  const [prior] = await conn.query(
    'SELECT * FROM domain_operations WHERE operation_id=? OR (source=? AND incarnation=? AND stream=? AND sequence=?)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
    ],
  );
  if (prior) {
    if (canonicalJson(fromRow(prior)) !== canonicalJson(operation)) {
      throw new Error('receipt operation divergence');
    }
    return false;
  }
  await conn.execute(
    'INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
      operation.semanticKey,
      'receipt',
      JSON.stringify(operation.context),
      operation.payloadHash,
      operation.payload,
    ],
  );
  return true;
}

export async function recordReceiptOperation(conn: Conn, mark: ReceiptMark) {
  const held = await control(conn);
  // Standalone/F1 and remote-user federation marks have no local F2 authorship.
  if (!held || domainOf(mark.userId) !== held.server) return;
  const node = held.nodes.find((node) => node.node === held.node);
  if (!node) throw new Error('receipt source unavailable');
  const source = { source: node.node, incarnation: node.incarnation };
  const semanticKey = key(mark), stream = 'receipts:' + semanticKey;
  const history = (await receiptOperations(conn, mark.userId)).filter((op) =>
    op.semanticKey === semanticKey
  );
  const ownTargets = new Set(
    history.filter((op) =>
      op.source === source.source && op.incarnation === source.incarnation
    ).flatMap((op) => receiptOperationMark(op).eventIds),
  );
  if (mark.eventIds.every((event) => ownTargets.has(event))) return;
  const known = new Set(history.map((op) => op.operationId));
  if (
    history.some((op) =>
      op.context.some((dot) =>
        domain(dot) === domain(source) && !known.has(id(dot, stream))
      )
    )
  ) throw new Error('local receipt predecessor unavailable');
  const vector = new Map<string, Dot>();
  for (const op of history) {
    for (const dot of [op, ...op.context]) {
      const prior = vector.get(domain(dot));
      if (!prior || prior.sequence < dot.sequence) {
        vector.set(domain(dot), {
          source: dot.source,
          incarnation: dot.incarnation,
          sequence: dot.sequence,
        });
      }
    }
  }
  const counter = 'domain:' +
    JSON.stringify([source.source, source.incarnation, stream]);
  await conn.execute(
    'INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)',
    [counter, vector.get(domain(source))?.sequence ?? 0],
  );
  await conn.execute('UPDATE counters SET value=value+1 WHERE name=?', [
    counter,
  ]);
  const [row] = await conn.query('SELECT value FROM counters WHERE name=?', [
    counter,
  ]);
  const sequence = Number(row.value), payload = canonicalJson(mark);
  const operation: ReceiptOperation = {
    ...source,
    sequence,
    stream,
    semanticKey,
    kind: 'receipt',
    operationId: id({ ...source, sequence }, stream),
    context: [...vector.values()].sort((a, b) =>
      domain(a) < domain(b) ? -1 : 1
    ),
    payload,
    payloadHash: digest(payload),
  };
  await acceptReceiptOperation(conn, operation, source);
  await conn.execute(
    'UPDATE domain_operations SET applied=1 WHERE operation_id=?',
    [operation.operationId],
  );
}

export async function pendingReceiptOperations(conn: Conn, roomId?: string) {
  return (await conn.query(
    "SELECT * FROM domain_operations WHERE kind='receipt' AND applied=0" +
      (roomId === undefined
        ? ''
        : " AND json_extract(payload_json,'$.roomId')=?"),
    roomId === undefined ? [] : [roomId],
  )).map(fromRow);
}
