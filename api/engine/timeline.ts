import { ident, serverDb, withDb } from './db.ts';
import { headExtremity } from './room.ts';
import type { Pdu } from './pdu.ts';

// Load one event's stored PDU by id, AS OF the commit that carries it
// (event rows live on x* branches — `main` only holds `state`).
export async function pduById(
  dbName: string,
  commitHash: string,
  eventId: string,
): Promise<Pdu | null> {
  if (!/^[a-z0-9]+$/i.test(commitHash)) {
    throw new Error('E_BAD_HASH: ' + commitHash);
  }
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT canonical_json FROM events AS OF '${commitHash}' WHERE event_id = $1;`,
      [eventId],
    );
    if (r.rows.length === 0) return null;
    const v = r.rows[0].canonical_json;
    return (typeof v === 'string' ? JSON.parse(v) : v) as Pdu;
  });
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
    // History reads follow the head extremity's branch (the documented
    // mid-fork "one side's history" simplification — deterministic now:
    // greatest tip depth, tie → smallest event_id, never soft-failed).
    const head = await headExtremity(dbName, roomId);
    if (!head) return [];
    await c.query(`SELECT DOLT_CHECKOUT('${ident(head.branch)}');`);
    const log = await c.query(
      `SELECT commit_hash, message FROM dolt.log LIMIT ${Math.floor(limit)};`,
    );

    const hashes = log.rows.map((r: { commit_hash: string }) =>
      String(r.commit_hash)
    );
    if (hashes.length === 0) return [];

    // commit_hash -> event_id via server DB (single ANY query); M3:
    // rejected AND soft-failed events are excluded from the
    // client-visible timeline (server-server-api.md 556-563, 611-614)
    const idx = await withDb(serverDb(), async (s) => {
      return await s.query(
        'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1 AND commit_hash = ANY($2) AND rejected = FALSE AND soft_failed = FALSE;',
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

// Current state lives on `main` (republished by ingest / reresolveFromDag
// whenever the extremity set changes) — readers never pick a branch.
export async function stateNow(dbName: string): Promise<unknown[]> {
  return await withDb(dbName, async (c) => {
    await c.query("SELECT DOLT_CHECKOUT('main');");
    const r = await c.query('SELECT * FROM state;');
    return r.rows;
  });
}
