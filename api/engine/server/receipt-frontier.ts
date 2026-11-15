// F2 read authority is an authenticated graph mark, never a replica's arrival
// counter. Project immutable accepted prev edges before using the server copy.
import type { Conn } from '#engine/store/db.ts';
import { receiptTargetInThread } from '#engine/server/read.ts';

export const RECEIPT_GRAPH_SQL = `
CREATE TABLE receipt_dag_nodes(room TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(room,event));
CREATE TABLE receipt_dag_edges(room TEXT NOT NULL,event TEXT NOT NULL,parent TEXT NOT NULL,PRIMARY KEY(room,event,parent));
CREATE INDEX receipt_dag_children ON receipt_dag_edges(room,parent,event);
CREATE TABLE notification_graph_reads(user TEXT NOT NULL,room TEXT NOT NULL,scope TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(user,room,scope,event));
INSERT INTO notification_graph_reads(user,room,scope,event)
  SELECT h.user,h.room,h.scope,i.event FROM notification_horizons h JOIN event_index i ON i.room=h.room AND i.seq=h.event_seq
  WHERE i.standing='accepted' AND i.grounding='grounded';
`;

/** A negotiated F2 activation changes the read contract. F1/standalone keeps
 * its existing stream contract; merely installing this schema does not opt in. */
export async function graphReceiptsEnabled(tx: Conn): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM facade_owner_activation LIMIT 1'))
    .length > 0;
}

export async function projectReceiptGraph(
  tx: Conn,
  room: string,
  event: string,
  prevs: readonly string[],
): Promise<void> {
  await tx.execute(
    'INSERT INTO receipt_dag_nodes(room,event) VALUES(?,?) ON CONFLICT DO NOTHING',
    [room, event],
  );
  for (const parent of prevs) {
    await tx.execute(
      'INSERT INTO receipt_dag_edges(room,event,parent) VALUES(?,?,?) ON CONFLICT DO NOTHING',
      [room, event, parent],
    );
  }
}

// UNION, not UNION ALL: malformed cycles cannot make a read walk unbounded.
// Missing edges prove nothing. There is no invented traversal quota or clock.
const PAST = `WITH RECURSIVE past(event) AS (
  SELECT ? UNION SELECT e.parent FROM receipt_dag_edges e JOIN past p ON e.event=p.event WHERE e.room=?
)`;

export async function receiptPrecedes(
  tx: Conn,
  room: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (await tx.query(PAST + ' SELECT 1 FROM past WHERE event=? LIMIT 1', [
    descendant,
    room,
    ancestor,
  ])).length > 0;
}

/** Keep unknown/concurrent identities. Only a proved proper ancestor retires. */
export async function receiptFrontier(
  tx: Conn,
  room: string,
  targets: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(targets)].sort();
  const frontier: string[] = [];
  for (const target of unique) {
    let dominated = false;
    for (const other of unique) {
      if (target !== other && await receiptPrecedes(tx, room, target, other)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) frontier.push(target);
  }
  return frontier;
}

export async function rememberGraphRead(
  tx: Conn,
  user: string,
  room: string,
  scope: string,
  event: string,
): Promise<void> {
  await tx.execute(
    'INSERT INTO notification_graph_reads(user,room,scope,event) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
    [user, room, scope, event],
  );
}

/** Validate each read fact against the receiver's held target/scope evidence.
 * A late history/prev/relation projection can make more ancestry provable. */
export async function graphReadTargets(
  tx: Conn,
  user: string,
  room: string,
  thread: string,
): Promise<string[]> {
  const rows = await tx.query(
    `SELECT r.scope,r.event FROM notification_graph_reads r
    JOIN event_index i ON i.room=r.room AND i.event=r.event
    JOIN receipt_dag_nodes n ON n.room=r.room AND n.event=r.event
    WHERE r.user=? AND r.room=? AND r.scope IN ('',?) AND i.standing='accepted' AND i.grounding='grounded'`,
    [user, room, thread],
  );
  const targets: string[] = [];
  for (const row of rows) {
    if (
      row.scope === '' ||
      await receiptTargetInThread(
        tx,
        room,
        String(row.event),
        String(row.scope),
      )
    ) targets.push(String(row.event));
  }
  return targets;
}

export async function graphNotificationRead(
  tx: Conn,
  user: string,
  room: string,
  thread: string,
  event: string,
): Promise<boolean> {
  for (const target of await graphReadTargets(tx, user, room, thread)) {
    if (await receiptPrecedes(tx, room, event, target)) return true;
  }
  return false;
}
