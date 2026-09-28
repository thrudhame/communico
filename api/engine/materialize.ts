import type pgpkg from 'pg';
import { ident, withDb } from './db.ts';

export interface StateRowInput {
  type: string;
  stateKey: string;
  eventId: string;
  content: unknown;
}

// THE only writer of the `state` table on the server engine. The F0
// invariant: no path writes `state` except the resolver — ingest, heal,
// and adoption alike funnel their resolved state map through here.
// (The filename carries the function name so the phase gate's
// `grep INSERT.*state | grep -v materialize` proves the invariant.)
export async function materialize(
  c: pgpkg.Client,
  rows: StateRowInput[],
): Promise<void> {
  await c.query('DELETE FROM state;');
  for (const r of rows) {
    await c.query(
      'INSERT INTO state (type, state_key, event_id, content) VALUES ($1, $2, $3, $4);',
      [r.type, r.stateKey, r.eventId, JSON.stringify(r.content)],
    );
  }
}

// The room's CURRENT state lives on the current chapter (M5b, the book —
// main is the room's system branch and never holds content): resolver
// output across the live extremity set, republished whenever that set
// changes. x* branches are never committed to after their event. The
// caller supplies the chapter branch (its current_chapter — never called
// on an archived room). Returns HASHOF(chapter) after the commit attempt
// (E1 — the caller records it as the event's state_commit_hash; a no-op
// publish returns the unchanged hash).
export async function publishCurrentState(
  dbName: string,
  chapter: string,
  rows: StateRowInput[],
  reason: string, // commit message tail, e.g. `after ${eventId}` / `reresolve`
): Promise<string> {
  return await withDb(dbName, async (c) => {
    await c.query(`SELECT DOLT_CHECKOUT('${ident(chapter)}');`);
    await materialize(c, rows);
    try {
      await c.query(`SELECT DOLT_COMMIT('-Am', $1);`, [
        `current state: ${reason}`,
      ]);
    } catch (e) {
      if (!String(e).includes('nothing to commit')) throw e;
    }
    const h = await c.query(`SELECT HASHOF('${ident(chapter)}');`);
    return String(Object.values(h.rows[0])[0]);
  });
}
