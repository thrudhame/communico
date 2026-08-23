// Merge driver v0 — latest-wins (D4; acknowledged throwaway pending real
// state-res v2). On a 2-prev ingest, Dolt's cell-wise merge is never
// trusted for the state table: contested (type, state_key) rows are
// resolved Matrix-side by (origin_ts, event_id) latest-wins.
//
// D6: the caller (ingest.ts) has already run
// SET dolt_allow_commit_conflicts = 1 on this client, checked out
// branch_0, and keeps the whole merge->resolve->commit sequence on this
// one client. This function never commits — ingest step 7 commits (the
// merge commit IS the new event's commit).
import type pgpkg from 'pg';

interface StateRow {
  type: string;
  state_key: string;
  event_id: string;
  content: unknown;
}

export async function mergeDriver(c: pgpkg.Client, otherBranch: string) {
  // 1. capture both side hashes BEFORE the merge (scalar-subquery form —
  //    bare = HASHOF(...) errors on merge tips, known planner bug)
  const oursHash = String(
    (await c.query(`SELECT (SELECT HASHOF('HEAD')) AS h;`)).rows[0].h,
  );
  const theirsHash = String(
    (await c.query(
      `SELECT (SELECT HASHOF('${otherBranch}')) AS h;`,
    )).rows[0].h,
  );

  await c.query(`SELECT DOLT_MERGE('${otherBranch}')`);

  const conflicts = await c.query(`SELECT * FROM dolt.conflicts`);
  // deno-lint-ignore no-explicit-any
  const conflictTables = conflicts.rows.map((r: any) =>
    String(r.table ?? r.name)
  );
  if (conflictTables.includes('events')) {
    // cannot happen (event_id PK unique per event, both sides only ADD)
    throw new Error(
      'STOP-AND-REPORT: dolt.conflicts lists events: ' +
        JSON.stringify(conflicts.rows),
    );
  }

  // 2. state rows in play on both sides (AS OF the pre-merge hashes)
  const ours: StateRow[] = (await c.query(
    `SELECT type, state_key, event_id, content FROM state AS OF '${oursHash}';`,
  )).rows;
  const theirs: StateRow[] = (await c.query(
    `SELECT type, state_key, event_id, content FROM state AS OF '${theirsHash}';`,
  )).rows;
  const theirsByKey = new Map(theirs.map((r) => [`${r.type}${r.state_key}`, r]));

  // 3. for contested keys (present on both sides, differing event_id):
  //    winner = greater (origin_ts, event_id), read from each side's
  //    events table AS OF the same hash
  const contested: { key: string; winner: StateRow }[] = [];
  for (const o of ours) {
    const t = theirsByKey.get(`${o.type}${o.state_key}`);
    if (!t || t.event_id === o.event_id) continue;
    const ourTs = Number(
      (await c.query(
        `SELECT origin_ts FROM events AS OF '${oursHash}' WHERE event_id = $1;`,
        [o.event_id],
      )).rows[0].origin_ts,
    );
    const theirTs = Number(
      (await c.query(
        `SELECT origin_ts FROM events AS OF '${theirsHash}' WHERE event_id = $1;`,
        [t.event_id],
      )).rows[0].origin_ts,
    );
    const winner = ourTs > theirTs ||
        (ourTs === theirTs && o.event_id > t.event_id)
      ? o
      : t;
    contested.push({ key: `${o.type}${o.state_key}`, winner });
  }

  // 4. clear conflicts (ours), then overwrite contested keys with winners
  for (const table of conflictTables) {
    await c.query(`SELECT DOLT_CONFLICTS_RESOLVE('--ours', '${table}')`);
  }
  for (const { winner } of contested) {
    await c.query(
      `UPDATE state SET event_id = $1, content = $2
       WHERE type = $3 AND state_key = $4;`,
      [
        winner.event_id,
        JSON.stringify(winner.content),
        winner.type,
        winner.state_key,
      ],
    );
  }

  // D6 GUARD: never return with unresolved conflicts pending.
  const left = await c.query(`SELECT * FROM dolt.conflicts`);
  if (left.rows.length > 0) {
    throw new Error(
      'mergeDriver: unresolved conflicts remain: ' + JSON.stringify(left.rows),
    );
  }
}
