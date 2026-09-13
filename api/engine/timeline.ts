import { serverDb, ident, withDb } from './db.ts';

// Reads (dolt.log / working set) reflect HEAD; a fresh client lands on
// `main`, which only ever holds the genesis commits — the event history
// lives on the x* extremity branches. So every read first checks out the
// extremity branch whose tip is newest (S2: dolt.branches carries
// latest_commit_date). With multiple extremities (mid-fork) this reads
// one side's history — recorded prototype simplification; after a merge
// event lands, the single remaining extremity covers the whole DAG.
async function checkoutReadHead(
  c: { query: (sql: string) => Promise<unknown> },
): Promise<void> {
  const r = await c.query(
    `SELECT name FROM dolt.branches WHERE name LIKE 'x%'
     ORDER BY latest_commit_date DESC, name ASC LIMIT 1;`,
  ) as { rows: { name: string }[] };
  if (r.rows.length > 0) {
    await c.query(`SELECT DOLT_CHECKOUT('${ident(r.rows[0].name)}');`);
  }
}

// Maps a commit to the events row it added (the commit=event invariant:
// exactly one added row). Returns the parsed canonical_json, or null for
// non-event commits. Shared by timeline.messages (Mode B) and syncfeed.
export async function eventAtCommit(
  c: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
  commitHash: string,
): Promise<Record<string, unknown> | null> {
  const d = await c.query(
    `SELECT * FROM dolt_diff('${commitHash}~', '${commitHash}', 'events');`,
  );
  // deno-lint-ignore no-explicit-any
  for (const dr of d.rows as any[]) {
    if (dr.diff_type !== 'added') continue;
    // F0: canonical_json is verbatim TEXT (not jsonb) — parse it.
    const v = dr.to_canonical_json as unknown;
    return (typeof v === 'string' ? JSON.parse(v) : v) as Record<
      string,
      unknown
    >;
  }
  return null;
}

export async function messages(
  dbName: string,
  roomId: string,
  limit = 50,
): Promise<unknown[]> {
  return await withDb(dbName, async (c) => {
    await checkoutReadHead(c);
    const log = await c.query(
      `SELECT commit_hash, message FROM dolt.log LIMIT ${Math.floor(limit)};`,
    );

    const hashes = log.rows.map((r: { commit_hash: string }) => String(r.commit_hash));
    if (hashes.length === 0) return [];

    // commit_hash -> event_id via server DB (single ANY query)
    const idx = await withDb(serverDb(), async (s) => {
      return await s.query(
        'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1 AND commit_hash = ANY($2);',
        [roomId, hashes],
      );
    });
    const byCommit = new Map(
      // deno-lint-ignore no-explicit-any
      idx.rows.map((r: any) => [String(r.commit_hash), String(r.event_id)]),
    );
    // deno-lint-ignore no-explicit-any
    const eventIds = [...new Set(idx.rows.map((r: any) => String(r.event_id)))];
    if (eventIds.length === 0) return [];

    const evs = await c.query(
      'SELECT event_id, canonical_json FROM events WHERE event_id = ANY($1);',
      [eventIds],
    );
    const byId = new Map(
      // deno-lint-ignore no-explicit-any
      evs.rows.map((r: any) => [
        String(r.event_id),
        // F0: canonical_json is verbatim TEXT — parse it.
        typeof r.canonical_json === 'string'
          ? JSON.parse(r.canonical_json)
          : r.canonical_json,
      ]),
    );

    // dolt.log is newest-first; commits without an event_index entry
    // (genesis schema commit etc.) are skipped
    const out: unknown[] = [];
    for (const row of log.rows) {
      const eid = byCommit.get(String(row.commit_hash));
      if (eid && byId.has(eid)) out.push(byId.get(eid));
    }
    return out;
  });
}

export async function stateNow(dbName: string): Promise<unknown[]> {
  return await withDb(dbName, async (c) => {
    await checkoutReadHead(c);
    const r = await c.query('SELECT * FROM state;');
    return r.rows;
  });
}
