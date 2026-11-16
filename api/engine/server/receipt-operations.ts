// Receipt intent belongs to the server receipt transaction. These immutable
// facts use the existing domain journal, but NEVER its register winner: read
// authority is the union of authenticated DAG marks, not a source/clock order.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf } from '#engine/ids.ts';
import type { Conn } from '#engine/store/db.ts';
import {
  type DomainHistoryProof,
  requireDomainSources,
} from '#engine/facade/domain-control.ts';

type Source = { source: string; incarnation: string };
type Dot = Source & { sequence: number };
export type ReceiptMark = {
  roomId: string;
  userId: string;
  receiptType: 'm.read' | 'm.read.private';
  threadId: string | null;
  eventIds: string[];
  ts: number;
  // A pre-F2 acknowledged row did not save its original join-event identity.
  // Home may explicitly attest that retained baseline with authentic historical
  // join evidence; it must not pretend this was a newly admitted client mark.
  admission: { membershipEvent: string; baseline?: true };
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
    admission: {
      membershipEvent: mark.admission.membershipEvent,
      ...(mark.admission.baseline === true ? { baseline: true as const } : {}),
    },
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
  history?: DomainHistoryProof,
): Promise<boolean> {
  const mark = receiptOperationMark(operation), held = await control(conn);
  if (
    !held || domainOf(mark.userId) !== held.server ||
    (mark.admission.baseline === true && operation.source !== 'home') ||
    operation.source !== authenticated.source ||
    operation.incarnation !== authenticated.incarnation
  ) throw new Error('receipt source unavailable');
  try {
    await requireDomainSources(
      conn,
      operation,
      held.nodes.map((node) => ({
        source: node.node,
        incarnation: node.incarnation,
      })),
      mark.userId.slice(1, mark.userId.indexOf(':')),
      history,
    );
  } catch {
    throw new Error('receipt source unavailable');
  }
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

async function writeReceiptOperation(conn: Conn, mark: ReceiptMark) {
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

/** Explicit home-only F1 -> F2 capture. The held acknowledged receipt is the
 * source fact; the historical join is disclosure/admission evidence, not a
 * claim that the original F1 row recorded that particular event. No current
 * membership check, client news, imported-source echo or replacement baseline. */
export async function captureReceiptOperations(
  conn: Conn,
  userId: string,
  onlyKey?: string,
) {
  const held = await control(conn);
  if (!held || held.node !== 'home' || domainOf(userId) !== held.server) {
    throw new Error('receipt bootstrap requires home authority');
  }
  const history = await receiptOperations(conn, userId);
  for (
    const row of await conn.query(
      'SELECT room_id,receipt_type,thread_id,event_ids,ts_ms FROM receipts WHERE user_id=? ORDER BY room_id,receipt_type,thread_id',
      [userId],
    )
  ) {
    const mark: ReceiptMark = {
      roomId: String(row.room_id),
      userId,
      receiptType: String(row.receipt_type) as ReceiptMark['receiptType'],
      threadId: row.thread_id === '' ? null : String(row.thread_id),
      eventIds: [...new Set<string>(JSON.parse(String(row.event_ids)))].sort(),
      ts: Number(row.ts_ms),
      admission: { membershipEvent: '', baseline: true },
    };
    if (onlyKey !== undefined && key(mark) !== onlyKey) continue;
    if (history.some((operation) => operation.semanticKey === key(mark))) {
      continue;
    }
    const [join] = await conn.query(
      "SELECT m.event FROM receipt_membership_events m JOIN event_index i ON i.room=m.room AND i.event=m.event WHERE m.room=? AND m.user=? AND m.membership='join' AND i.standing='accepted' AND i.grounding='grounded' ORDER BY m.event LIMIT 1",
      [mark.roomId, userId],
    );
    if (!join) throw new Error('receipt baseline admission unavailable');
    mark.admission.membershipEvent = String(join.event);
    await writeReceiptOperation(conn, mark);
  }
  return await receiptOperations(conn, userId);
}

/** Local admission calls this BEFORE changing the visible row. A LAN write can
 * race initial semantic bootstrap; preserve the acknowledged F1 slot first,
 * then record the new mark with its actual admission as an observed successor. */
export async function recordReceiptOperation(conn: Conn, mark: ReceiptMark) {
  const held = await control(conn);
  if (
    held?.node === 'home' && domainOf(mark.userId) === held.server &&
    !(await conn.query(
      'SELECT 1 FROM domain_operations WHERE semantic_key=? LIMIT 1',
      [key(mark)],
    )).length
  ) {
    await captureReceiptOperations(conn, mark.userId, key(mark));
  }
  await writeReceiptOperation(conn, mark);
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
