// Membership results live beside the room mutation, not in a process cache or
// a later server projection. The caller owns authentication and wire variants.
import { canonicalJson } from '#engine/canonical.ts';
import { createHash } from 'node:crypto';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';

export const MEMBERSHIP_RECEIPTS_SQL = `
CREATE TABLE membership_receipt_wires(
  hash TEXT PRIMARY KEY NOT NULL,
  wire_json TEXT NOT NULL
);
CREATE TABLE membership_receipts(
  operation TEXT PRIMARY KEY NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
);
`;

// Only protocol wire fields are content-addressed. Their ordered lists live in
// the receipt, not in mutable event/signature projections. Every membership
// result (including knock state) passes through this same persistence owner.
const wireArrays = ['state', 'auth_chain', 'knock_room_state'] as const;

async function hydrate(conn: Conn, encoded: string) {
  const result: Record<string, unknown> = JSON.parse(encoded);
  for (const field of wireArrays) {
    if (!Array.isArray(result[field])) continue;
    const refs = result[field] as string[];
    const rows = await conn.query(
      `SELECT w.wire_json FROM json_each(?) AS r
       JOIN membership_receipt_wires AS w ON w.hash=r.value
       ORDER BY CAST(r.key AS INTEGER)`,
      [JSON.stringify(refs)],
    );
    if (rows.length !== refs.length) {
      throw new Error('E_MEMBERSHIP_WIRE_MISSING');
    }
    result[field] = rows.map((row) => JSON.parse(String(row.wire_json)));
  }
  if (typeof result.event === 'string') {
    const [row] = await conn.query(
      'SELECT wire_json FROM membership_receipt_wires WHERE hash=?',
      [result.event],
    );
    if (!row) throw new Error('E_MEMBERSHIP_WIRE_MISSING');
    result.event = JSON.parse(String(row.wire_json));
  }
  return result;
}

// Admission may distinguish new work from a retained operation without reading
// its result. Authentication/material checks still precede membershipReceipt.
export async function hasMembershipReceipt(
  conn: Conn,
  operation: string,
): Promise<boolean> {
  return (await conn.query(
    'SELECT 1 FROM membership_receipts WHERE operation=?',
    [operation],
  )).length !== 0;
}

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
  return await hydrate(conn, String(row.result_json));
}

export async function saveMembershipReceipt(
  conn: Conn,
  operation: string,
  inputHash: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prior = await membershipReceipt(conn, operation, inputHash);
  if (prior !== null) return prior;
  const references = { ...result };
  const wires = new Map<string, string>();
  const pin = (wire: unknown) => {
    const bytes = canonicalJson(wire);
    const hash = createHash('sha256').update(bytes).digest('hex');
    wires.set(hash, bytes);
    return hash;
  };
  for (const field of wireArrays) {
    if (Array.isArray(result[field])) {
      references[field] = (result[field] as unknown[]).map(pin);
    }
  }
  if (result.event !== undefined) references.event = pin(result.event);
  // Bound SQL parameters, not result size. One payload per content survives
  // across fields and operations; signature variants have different hashes.
  const entries = [...wires];
  for (let start = 0; start < entries.length; start += 200) {
    const page = entries.slice(start, start + 200);
    await conn.execute(
      `INSERT INTO membership_receipt_wires(hash,wire_json) VALUES ${
        page.map(() => '(?,?)').join(',')
      } ON CONFLICT(hash) DO NOTHING`,
      page.flat(),
    );
  }
  const encoded = canonicalJson(references);
  await conn.execute(
    'INSERT INTO membership_receipts(operation,input_hash,result_json) VALUES(?,?,?)',
    [operation, inputHash, encoded],
  );
  return await hydrate(conn, encoded);
}
