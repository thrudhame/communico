import type { Store } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';

// OOB protocol results belong to the same server transaction as their prejoin
// transition. They outlive the current display row and are not display authority.
export const MEMBERSHIP_OPERATIONS_SQL = `
CREATE TABLE membership_operations(operation TEXT PRIMARY KEY NOT NULL,room_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL);
`;

export async function prejoinResult(
  tx: Pick<Conn, 'query'>,
  operation: string,
  inputHash: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx.query(
    'SELECT input_hash,result_json FROM membership_operations WHERE operation=?',
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

export async function savePrejoinResult(
  tx: Conn,
  operation: string,
  roomId: string,
  inputHash: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const retained = await prejoinResult(tx, operation, inputHash);
  if (retained !== null) return retained;
  const encoded = canonicalJson(result);
  await tx.execute(
    'INSERT INTO membership_operations(operation,room_id,input_hash,result_json) VALUES(?,?,?,?)',
    [operation, roomId, inputHash, encoded],
  );
  return JSON.parse(encoded);
}

// The room publication and OOB membership share the event allocator. A later
// room publication wins, even before a post-join marker can clear the OOB row.
// All membership display/count consumers use this one selection contract.
export function visiblePrejoin(alias: string) {
  return `NOT EXISTS (SELECT 1 FROM memberships m WHERE m.room=${alias}.room_id AND m.user=${alias}.user_id AND m.seq>=${alias}.seq)`;
}

export function visibleRoomMembership(alias: string) {
  return `NOT EXISTS (SELECT 1 FROM prejoin_memberships p WHERE p.user_id=${alias}.user AND p.room_id=${alias}.room AND p.status NOT IN ('joined','attempting','failed-attempt') AND p.seq>${alias}.seq)`;
}

// A superseded durable intent can be cancelled, but an already dispatched leave
// must drain first. Process death ends the request; restart can cancel the row.
const leaving = new WeakMap<Store, Map<string, number>>();
export function prejoinLeaveActive(store: Store, room: string, user: string) {
  return (leaving.get(store)?.get(JSON.stringify([room, user])) ?? 0) > 0;
}
export function beginPrejoinLeave(store: Store, room: string, user: string) {
  let entries = leaving.get(store);
  if (!entries) leaving.set(store, entries = new Map());
  const key = JSON.stringify([room, user]);
  entries.set(key, (entries.get(key) ?? 0) + 1);
  return () => {
    const count = entries.get(key)!;
    if (count === 1) entries.delete(key);
    else entries.set(key, count - 1);
  };
}

export async function settleSupersededPrejoin(
  tx: Conn,
  room: string,
  user: string,
) {
  await tx.execute(
    `UPDATE prejoin_memberships SET status='rejected' WHERE room_id=? AND user_id=? AND status IN ('rejecting','failed-retract') AND NOT (${
      visiblePrejoin('prejoin_memberships')
    })`,
    [room, user],
  );
}
