// Room truth audits use held local references. Missing remote auth/prev events
// and imported state boundaries are valid; held prev edges must form a DAG.
import type { CapturedQuery } from '#engine/store/inspect.ts';
import { absent, nonnegative, scan } from '#engine/backup/checks.ts';
import { edgeIds } from './events.ts';

export async function auditRoom(
  db: CapturedQuery,
  id: string,
): Promise<Record<string, number>> {
  for (
    const [sql, reason] of [
      [
        'SELECT 1 FROM events e LEFT JOIN event_topology t ON t.event=e.id WHERE t.event IS NULL OR t.height<1 LIMIT 1',
        'missing topology',
      ],
      [
        'SELECT 1 FROM event_topology t LEFT JOIN events e ON e.id=t.event WHERE e.id IS NULL LIMIT 1',
        'orphan topology',
      ],
      [
        'SELECT 1 FROM prev_edges p JOIN event_topology c ON c.event=p.event JOIN event_topology a ON a.event=p.prev WHERE c.height<=a.height LIMIT 1',
        'cyclic or regressed topology',
      ],
      [
        "SELECT 1 FROM event_status s LEFT JOIN events e ON e.id=s.event WHERE e.id IS NULL OR s.standing NOT IN ('accepted','rejected','soft_failed') OR s.grounding NOT IN ('grounded','evidence','pending') LIMIT 1",
        'invalid event status',
      ],
      [
        'SELECT 1 FROM events e LEFT JOIN event_status s ON s.event=e.id WHERE s.event IS NULL LIMIT 1',
        'missing event status',
      ],
      [
        'SELECT 1 FROM state_groups g LEFT JOIN state_groups p ON p.id=g.parent WHERE (g.parent IS NOT NULL AND (p.id IS NULL OR p.depth>=g.depth)) OR g.depth<0 LIMIT 1',
        'state group parent',
      ],
    ]
  ) await absent(db, sql, reason);
  // Every declared local reference is checked even when native foreign-key
  // enforcement is disabled. Nullable remote/missing-history targets are not.
  for (
    const [table, column, target, key] of [
      ['prev_edges', 'event', 'events', 'id'],
      ['auth_edges', 'event', 'events', 'id'],
      ['state_entries', 'grp', 'state_groups', 'id'],
      ['state_entries', 'event', 'events', 'id'],
      ['event_state', 'event', 'events', 'id'],
      ['event_state', 'before_group', 'state_groups', 'id'],
      ['event_state', 'after_group', 'state_groups', 'id'],
      ['segments', 'prev', 'segments', 'id'],
      ['segments', 'opened_by', 'events', 'id'],
      ['segments', 'opening_group', 'state_groups', 'id'],
      ['segments', 'current_group', 'state_groups', 'id'],
      ['positions', 'segment', 'segments', 'id'],
      ['positions', 'event', 'events', 'id'],
      ['extremities', 'stay', 'segments', 'id'],
      ['extremities', 'event', 'events', 'id'],
      ['publications', 'stay', 'segments', 'id'],
      ['publications', 'change_pos', 'changes', 'pos'],
      ['publications', 'grp', 'state_groups', 'id'],
      ['publication_keys', 'change_pos', 'changes', 'pos'],
      ['publication_keys', 'event', 'events', 'id'],
      ['changes', 'event', 'events', 'id'],
    ]
  ) {
    await absent(
      db,
      `SELECT 1 FROM ${table} s LEFT JOIN ${target} t ON t.${key}=s.${column} WHERE s.${column} IS NOT NULL AND t.${key} IS NULL LIMIT 1`,
      'broken room reference: ' + table + '.' + column,
    );
  }
  for await (
    const row of scan(
      db,
      'events',
      'id,pdu,type,state_key,sender,depth,origin_ts',
    )
  ) {
    const pdu = JSON.parse(String(row.pdu));
    if (
      pdu.room_id !== id || pdu.event_id !== row.id || pdu.type !== row.type ||
      (pdu.state_key ?? null) !== row.state_key || pdu.sender !== row.sender ||
      pdu.depth !== row.depth || pdu.origin_server_ts !== row.origin_ts
    ) {
      throw new Error('backup audit: room PDU/index mismatch');
    }
    for (
      const [table, column, wire] of [['prev_edges', 'prev', 'prev_events'], [
        'auth_edges',
        'auth',
        'auth_events',
      ]]
    ) {
      const expected = [...new Set(edgeIds(pdu[wire]))];
      const actual = (await db.query(
        `SELECT ${column} AS target FROM ${table} WHERE event=? ORDER BY ord`,
        [row.id],
      )).map((edge) => String(edge.target));
      if (
        expected.length !== actual.length ||
        expected.some((id, i) => actual[i] !== id)
      ) {
        throw new Error('backup audit: PDU edge index mismatch');
      }
    }
  }
  const [{ segment }] = await db.query(
    'SELECT COALESCE(MAX(id),0) AS segment FROM segments',
  );
  const next = await db.query("SELECT v FROM meta WHERE k='next_segment'");
  if (
    segment !== 0 &&
    (next.length !== 1 || String(Number(next[0].v)) !== next[0].v ||
      nonnegative(Number(next[0].v), 'segment allocator') <= Number(segment))
  ) {
    throw new Error('backup audit: segment allocator behind source');
  }
  const [{ head }] = await db.query(
    'SELECT COALESCE(MAX(pos),0) AS head FROM changes',
  );
  return { changes: nonnegative(head, 'room change head') };
}
