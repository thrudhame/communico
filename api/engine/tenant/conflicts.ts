// Explicit operator recovery reads, scoped to the semantic tenant owners. No
// credential/session/pool tables, value materialization, or new source writes.
import type { Conn } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  readRegister,
  type RegisterOperation,
} from '#engine/facade/registers.ts';

export type ConflictSelector =
  | { kind: 'account-data'; localpart: string; roomId: string; type: string }
  | { kind: 'profile' | 'push-rules'; localpart: string };

async function alternatives(conn: Conn, selector: ConflictSelector) {
  const [user] = await conn.query('SELECT 1 FROM users WHERE localpart=?', [
    selector.localpart,
  ]);
  if (!user) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown account');
  const key = JSON.stringify(
    selector.kind === 'account-data'
      ? [selector.kind, selector.localpart, selector.roomId, selector.type]
      : [selector.kind, selector.localpart],
  );
  const view = await readRegister(conn, key);
  // Tag puts/removes/reset share a history, but their projection is NOT the
  // single-value register winner. Expose retained history without mislabeling
  // an independent tag operation as a losing complete m.tag value.
  const tags = selector.kind === 'account-data' && selector.type === 'm.tag';
  const operations = tags
    ? [...view.conflicts, ...(view.winner ? [view.winner] : [])]
    : view.conflicts;
  return { view, operations, tags };
}

function metadata(operation: RegisterOperation) {
  return {
    operationId: operation.operationId,
    source: operation.source,
    incarnation: operation.incarnation,
    sequence: operation.sequence,
    payloadHash: operation.payloadHash,
  };
}

export async function inspectConflicts(conn: Conn, selector: ConflictSelector) {
  const { view, operations, tags } = await alternatives(conn, selector);
  const frontier = new Set(view.frontier.map((op) => op.operationId));
  return {
    winner: tags ? null : view.winner?.operationId ?? null,
    pending: view.pending.length,
    alternatives: operations.map((op) => ({
      ...metadata(op),
      state: tags
        ? 'retained'
        : frontier.has(op.operationId)
        ? 'concurrent'
        : 'superseded',
    })),
  };
}

export async function exportConflict(
  conn: Conn,
  selector: ConflictSelector,
  operationId: string,
) {
  const { operations } = await alternatives(conn, selector);
  const operation = operations.find((op) => op.operationId === operationId);
  if (!operation) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'retained alternative not found');
  }
  // The immutable operation is the provenance. Its opaque JSON string stays
  // intact; neither JSON integer canonicalization nor a recovery merge runs.
  return { selector, operation };
}
