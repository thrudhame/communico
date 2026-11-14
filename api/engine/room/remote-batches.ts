// A cross-file caller can lose its receipt after the room has committed.
// Keep the original outcomes beside that commit, including negative results
// which a later ACL/grounding/key change must not turn into a new answer.
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn } from '#engine/store/db.ts';
import type { RemoteOutcome } from './remote.ts';

export const REMOTE_BATCHES_SQL = `
CREATE TABLE remote_batches(operation_id TEXT PRIMARY KEY NOT NULL,input_hash TEXT NOT NULL,response TEXT NOT NULL);
`;

export async function remoteBatch(
  conn: Conn,
  operationId: string,
  inputHash: string,
): Promise<RemoteOutcome[] | null> {
  const [row] = await conn.query(
    'SELECT input_hash,response FROM remote_batches WHERE operation_id=?',
    [operationId],
  );
  if (!row) return null;
  if (row.input_hash !== inputHash) throw new Error('E_REMOTE_BATCH_COLLISION');
  return JSON.parse(String(row.response)) as RemoteOutcome[];
}

export async function saveRemoteBatch(
  conn: Conn,
  operationId: string,
  inputHash: string,
  outcomes: RemoteOutcome[],
): Promise<RemoteOutcome[]> {
  const prior = await remoteBatch(conn, operationId, inputHash);
  if (prior) return prior;
  const encoded = canonicalJson(outcomes);
  await conn.execute(
    'INSERT INTO remote_batches(operation_id,input_hash,response) VALUES(?,?,?)',
    [operationId, inputHash, encoded],
  );
  return JSON.parse(encoded) as RemoteOutcome[];
}
