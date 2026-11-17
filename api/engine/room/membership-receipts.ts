// Membership results live beside the room mutation, not in a process cache or
// a later server projection. The caller owns authentication and wire variants.
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';

export const MEMBERSHIP_RECEIPTS_SQL = `
CREATE TABLE membership_receipts(
  operation TEXT PRIMARY KEY NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
);
`;

export async function membershipReceipt(
  conn: Conn,
  operation: string,
  inputHash: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await conn.query(
    'SELECT input_hash,result_json FROM membership_receipts WHERE operation=?',
    [operation],
  );
  if (!row) return null;
  if (row.input_hash !== inputHash) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'membership operation material changed',
    );
  }
  return JSON.parse(String(row.result_json));
}

export async function saveMembershipReceipt(
  conn: Conn,
  operation: string,
  inputHash: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prior = await membershipReceipt(conn, operation, inputHash);
  if (prior !== null) return prior;
  const encoded = canonicalJson(result);
  await conn.execute(
    'INSERT INTO membership_receipts(operation,input_hash,result_json) VALUES(?,?,?)',
    [operation, inputHash, encoded],
  );
  return JSON.parse(encoded);
}
