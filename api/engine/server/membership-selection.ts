// The lifecycle owner calls this after materializing verified display evidence,
// in the same server transaction. This is not PDU admission or a link receipt.
import type { Conn } from '#engine/store/db.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { membershipDisplay } from './membership-display.ts';
import {
  type MembershipOperation,
  type MembershipState,
  membershipStateOf,
} from './membership-operations.ts';

export async function bindMembershipDisplay(
  conn: Conn,
  roomId: string,
  userId: string,
  selected: MembershipOperation[],
): Promise<void> {
  const semanticKey = canonicalJson(['membership', roomId, userId]);
  const actual = (await membershipDisplay(conn, semanticKey, false)).display;
  const ordered = (operations: MembershipOperation[]) =>
    [...operations].sort((a, b) =>
      a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0
    );
  if (
    !actual.length ||
    canonicalJson(ordered(actual)) !== canonicalJson(ordered(selected))
  ) {
    throw new Error('membership display selection changed');
  }
  const [row] = await conn.query(
    'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
    [roomId, userId],
  );
  if (!row) throw new Error('membership display materialization unavailable');
  const state = membershipStateOf(row);
  for (const operation of actual) {
    const original = JSON.parse(operation.payload) as MembershipState;
    if (
      state.eventId !== original.eventId ||
      state.roomVersion !== original.roomVersion ||
      state.kind !== original.kind || state.status !== original.status
    ) {
      throw new Error('membership display materialization changed');
    }
  }
  const operations = actual.map((operation) => operation.operationId).sort();
  await conn.execute(
    'UPDATE prejoin_memberships SET source_binding=? WHERE room_id=? AND user_id=?',
    [canonicalJson({ state, operations }), roomId, userId],
  );
  await conn.execute('DELETE FROM domain_frontiers WHERE semantic_key=?', [
    semanticKey,
  ]);
  for (const operationId of operations) {
    await conn.execute(
      'INSERT INTO domain_frontiers(semantic_key,operation_id) VALUES(?,?)',
      [semanticKey, operationId],
    );
  }
}
