// Merge driver — MECHANICAL ONLY (F0: latest-wins retired as an exploit;
// any member forged ts=2^53 and owned any state key forever).
// On a multi-prev ingest, resolution is computed by the caller from the
// full parent-state sets via the room version's rulebook BEFORE this runs
// (the chain is bookkeeping, never associative assumption). This function
// performs Dolt's join, clears conflicts --ours, and commits nothing —
// ingest step 7 commits (the merge commit IS the new event's commit). The
// caller then funnels the resolved map through materialize(), the only
// writer of `state`.
//
// D6: the caller (ingest.ts) has already run
// SET dolt_allow_commit_conflicts = 1 on this client, checked out
// branch_0, and keeps the whole merge->resolve->commit sequence on this
// one client. This function never commits.
import type pgpkg from 'pg';

export async function mergeDriver(c: pgpkg.Client, otherBranch: string) {
  // --no-commit: the merge joins the working set only; the caller commits
  // once (the merge commit IS the new event's commit — commit = event).
  // A clean merge would otherwise auto-commit and split one event across
  // two commits.
  await c.query(`SELECT DOLT_MERGE('--no-commit', '${otherBranch}')`);

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

  // Clear conflicts --ours unconditionally: the working tree's `state`
  // rows are placeholders until materialize() overwrites them with the
  // rulebook's resolution. Dolt decides nothing here.
  for (const table of conflictTables) {
    await c.query(`SELECT DOLT_CONFLICTS_RESOLVE('--ours', '${table}')`);
  }

  // D6 GUARD: never return with unresolved conflicts pending.
  const left = await c.query(`SELECT * FROM dolt.conflicts`);
  if (left.rows.length > 0) {
    throw new Error(
      'mergeDriver: unresolved conflicts remain: ' + JSON.stringify(left.rows),
    );
  }
}
