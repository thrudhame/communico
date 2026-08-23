# Capability matrix & execution log

Doltgres 1.2.0 inside container `communico-dev`; spikes run with
`deno run --allow-net --allow-env spikes/<file>` (S7 also needs
`--allow-write` for `Deno.mkdir('/tmp/remotes')` — recorded below).

Execution note: first pass hit blocker B1 (S3 FAIL in autocommit mode).
Resolved by user decision **D6** (sanctioned merge mechanism:
`SET dolt_allow_commit_conflicts = 1` per session — see `## Blockers`
for history). Per phase-0 Revision R1 the spike databases were dropped,
all spikes re-run S1→S7 in order; every result below reflects the final
syntax and final DB state.

## S1 — db-per-room

Status: PASS

Discovered syntax (all primary forms worked verbatim):
- `CREATE DATABASE spike_room1;` — works from a client connected to `postgres`
- `SELECT DOLT_COMMIT('-Am', 's1 first commit');` — works; result column is
  named `dolt_commit` and contains the new hash
- `SELECT * FROM dolt.log;` — works; columns include
  `commit_hash, committer, email, date, message, commit_order, parents, refs, ...`
- Branch-addressed connect WORKS: connecting with `database: 'spike_room1/main'`
  succeeds and `SELECT active_branch();` returns `main`.

Notes:
- `CREATE DATABASE` itself creates a commit on the new DB
  ("Initialize data repository" → "CREATE DATABASE" are the first two log
  rows) — 2 implicit init commits before the first user commit.

Raw results block (final run):
```
- ok CREATE DATABASE spike_room1: []
- ok CREATE TABLE t1 on spike_room1: []
- ok INSERT INTO t1: []
- ok DOLT_COMMIT first commit: {"form":"SELECT DOLT_COMMIT('-Am', 's1 first commit');","rows":[{"dolt_commit":"hh2nejc9a8btgn8fl35krreroq7nit9f"}]}
- ok captured commit hash: hh2nejc9a8btgn8fl35krreroq7nit9f
- ok dolt.log contains 's1 first commit': 3 log row(s); messages: s1 first commit | CREATE DATABASE | Initialize data repository
- ok branch-addressed connection: database 'spike_room1/main' connected; active_branch() = main
```

## S2 — branch ops

Status: PASS

Discovered syntax:
- `SELECT DOLT_CHECKOUT('main');` → returns `(0,"Switched to branch 'x'")`
  style strings in column `dolt_checkout`.
- `SELECT DOLT_BRANCH('b1');` → returns `0`.
- `SELECT * FROM dolt_log('b1');` — table-function form works.
- `SELECT HASHOF('b1');` / `SELECT HASHOF('main');` — work, distinct hashes.
- `SELECT * FROM dolt.branches;` — works; name column `name`.
- Branch delete: **`SELECT DOLT_BRANCH('-d', 'b1');` FAILED** (branch not
  merged into main — Dolt refuses); the listed alternate
  `SELECT DOLT_BRANCH('-D', 'b1');` (force) WORKED.

Notes:
- **SESSION SCOPE ANSWER (step 7): a fresh client/session starts on
  `main`**, regardless of where other sessions are checked out. Branch
  state is per-session; new sessions default to `main`.

Raw results block (final run):
```
- ok DOLT_CHECKOUT('main') / DOLT_BRANCH('b1') / DOLT_CHECKOUT('b1') / active_branch() == b1
- ok INSERT (2,'b') / DOLT_COMMIT s2 on b1: 9fbl6dt4rvg9opk3ov4spl4scc2ipj7d
- ok dolt_log('b1') contains 's2 commit on b1': 4 row(s)
- ok HASHOF(b1)=9fbl6dt4... != HASHOF(main)=hh2nejc9...
- ok second client active_branch() (session scope): [{"active_branch":"main"}]
- ok dolt.branches lists main and b1
- ok delete branch b1: form: SELECT DOLT_BRANCH('-D', 'b1');
```

## S3 — merge driver

Status: PASS (REVISED run per D6; original autocommit-only run FAILED —
see `## Blockers` B1)

Discovered syntax (verbatim final forms, executed on ONE client):
```sql
SELECT DOLT_CHECKOUT('ma');
SET dolt_allow_commit_conflicts = 1;                 -- D6, session-scoped
SELECT DOLT_MERGE('mb');                             -- returns ("",0,1,"conflicts found"), no error
SELECT * FROM dolt.conflicts;                        -- {"table":"state","num_conflicts":"1"}
SELECT * FROM dolt_conflicts_state;                  -- detail rows, columns below
SELECT DOLT_CONFLICTS_RESOLVE('--ours', 'state');
UPDATE state SET v = 'DRIVER-DECIDED' WHERE k = 'topic';
SELECT * FROM dolt.conflicts;                        -- GUARD: 0 rows
SELECT DOLT_COMMIT('-Am', 's3 merge with driver content');
SELECT parent_hash FROM dolt.commit_ancestors
 WHERE commit_hash = (SELECT HASHOF('ma'));          -- scalar-subquery REQUIRED
SELECT v FROM state AS OF HASHOF('ma') WHERE k = 'topic';
```

Notes:
- `dolt.conflicts` columns: `table`, `num_conflicts`.
  `dolt_conflicts_state` columns: `from_root_ish, base_k, base_v, our_k,
  our_v, our_diff_type, their_k, their_v, their_diff_type,
  dolt_conflict_id`.
- The merge result shape: `("",0,1,"conflicts found")` (hash, fast-forward,
  conflicts, message).
- The held conflict state dies with the session — the whole
  merge→resolve→commit sequence must stay on one client.
- KEYSTONE VERIFIED: merge commit `i0dde3l4f378g36kni2n8f8njpid66em` has
  EXACTLY 2 distinct parents (`0cm6hnsr...` ma-cats, `urif61lu...` mb-dogs)
  and content `DRIVER-DECIDED` both live and `AS OF HASHOF('ma')`.

Raw results block (final run):
```
- ok SET dolt_allow_commit_conflicts = 1 (D6): []
- ok DOLT_MERGE('mb'): [{"dolt_merge":"(\"\",0,1,\"conflicts found\")"}]
- ok dolt.conflicts lists state / num_conflicts == 1
- ok dolt_conflicts_state columns recorded
- ok DOLT_CONFLICTS_RESOLVE('--ours', 'state'): [{"dolt_conflicts_resolve":"0"}]
- ok UPDATE state DRIVER-DECIDED
- ok GUARD: dolt.conflicts empty: 0 row(s)
- ok DOLT_COMMIT: i0dde3l4f378g36kni2n8f8njpid66em
- ok KEYSTONE: EXACTLY 2 distinct parents
- ok live + AS OF content == 'DRIVER-DECIDED'
```

## S4 — n-parent commits

Status: EXPECTED_GAP

Discovered syntax / behavior:
- `SELECT DOLT_MERGE('mb', 'mc');` (two branch args) fails verbatim with:
  ```
  error: Error: Dolt does not support merging from multiple commits. You
  probably meant to checkout one and then merge from the other.
  ```
- Whole-graph parent census (query added by executor, informational):
  `SELECT commit_hash, COUNT(*) AS parents FROM dolt.commit_ancestors
   GROUP BY commit_hash ORDER BY parents DESC LIMIT 3;`
  → max = 2 (the S3 merge commit). Confirms 2 is the ceiling.
- Deviation: the phase-file query `... WHERE commit_hash = HASHOF('ma')`
  was run in the scalar-subquery form `WHERE commit_hash = (SELECT
  HASHOF('ma'))` per the README convention (bare form errors on merge tips
  — known planner bug, see Blockers B1 side discovery).

Raw results block (final run):
```
- ok mc branch created off main, 'birds' committed (sh7vi2p9fnn4a16pejg3q5155dbm0c6b)
- ok DOLT_MERGE('mb','mc'): failed as expected (error verbatim above)
- ok commit_ancestors of (SELECT HASHOF('ma')): 2 parent rows (the S3 merge)
- ok max parents anywhere <= 2: max = 2
```

## S5 — asof/diff

Status: PASS

Discovered syntax:
- `SELECT * FROM t1 AS OF '<commit>';` — works; returns historical row set.
- `SELECT * FROM dolt_diff('<from>', '<to>', 't1');` — works; columns:
  `to_id, to_v, to_commit, to_commit_date, from_id, from_v, from_commit,
  from_commit_date, diff_type` (`diff_type` = `added` for the created row).
- `SELECT * FROM dolt_diff_stat('<from>', '<to>', 't1');` — works; 1 row
  with `table_name, rows_unmodified, rows_added, rows_deleted,
  rows_modified, cells_*, old_row_count, new_row_count, ...`.
- `USE spike_room1/main;` — SUPPORTED.

Notes (deviations from phase file, both also in the spike source):
- The phase file's single-`H2` expectations are not jointly satisfiable on
  this DB: t1 only changed in its creation commit, and `AS OF` a commit
  predating t1's creation **errors** with `table not found: t1`. Therefore:
  step 1 used `H2a` = 's1 first commit' (older row set returned; row
  (2,'b') absent ✓ — it only ever existed on the deleted branch b1);
  steps 2–3 used `H2b` = the oldest hash (init), spanning t1's creation
  (diff ≥1 row ✓, diff_stat 1 row ✓).
- `dolt_diff` over a range where the table did not change returns 0 rows
  (verified: 's1 first commit' → 's3 base' on t1 → empty).

## S6 — sql features

Status: PASS (script ran to the end; every item ✅ on its top rung)

Discovered syntax:
- **JSONB works** — top rung, no fallback needed:
  `CREATE TABLE j1 (id int PRIMARY KEY, doc jsonb);` and
  `SELECT doc->'a'->>'b' AS x FROM j1;` → `7`.
- Recursive CTE works: `WITH RECURSIVE nums(n) AS (...) SELECT count(*)` → 5.
- PL/pgSQL works: `CREATE FUNCTION ... LANGUAGE plpgsql;` + call → 5.
- Engine implication: use `jsonb` columns as written in phase-1 SQL (no
  substitution needed).

## S7 — remotes

Status: PASS

Discovered syntax (all primary forms worked):
- `SELECT DOLT_REMOTE('add', 'origin', 'file:///tmp/remotes/spike_room1');` → 0
- `SELECT DOLT_PUSH('origin', 'main');` → `(0,"To file://... [new branch] main -> main")`
- `SELECT DOLT_CLONE('file:///tmp/remotes/spike_room1', 'spike_clone');` —
  run from a client connected to `postgres`; creates the new database → 0
- `SELECT DOLT_PULL('origin');` (primary form) → `(1,0,"merge successful")`
- Full cycle verified: row inserted+committed+pushed on `spike_room1`
  appears on `spike_clone` after pull.

Notes:
- S7 needs `--allow-write` (`Deno.mkdir('/tmp/remotes')`). Command used:
  `deno run --allow-net --allow-env --allow-write spikes/s7_remotes.ts`
- Whether clone/pull brings remote BRANCHES (not just `main`) was not
  exercised (only `main` was pushed); Phase 3 needs this — phase-3.md
  already anticipates it.

## Phase 0 log

Status: COMPLETE

Deviations:
- S2: branch delete required the listed `-D` alternate (`-d` refused:
  branch not fully merged).
- S3: executed with the D6 sanctioned mechanism (SET + single-form
  `DOLT_MERGE('mb')` + GUARD + scalar-subquery keystone form) per revised
  phase-0 steps — all recorded in the S3 section.
- S4: `commit_ancestors` query run in scalar-subquery form (planner bug).
- S5: two-hash expectations split across H2a/H2b as documented above.
- S7: run with extra `--allow-write` flag.
- Revision R1 resume: `DROP DATABASE IF EXISTS spike_room1` /
  `spike_clone` and `rm -rf /tmp/remotes` executed per phase-0 R1 step 2
  (explicitly instructed there; supersedes the cleanup rule for the
  resume), then all spikes re-run S1→S7 in order.
- `deno.lock` gets auto-trimmed by deno when running spikes (root-level
  scripts only reference `pg`); restored to HEAD afterward. Harmless —
  regenerates on demand.
- Phase 1 gate evaluation: S1 PASS, S2 PASS, S3 PASS, S5 PASS →
  **gate MET** → proceeding to phase-1.md.

## Phase 1 log

Status: COMPLETE

(Initially reported BLOCKED under B2 — resolved by decision D7, taken by
the validator session under user delegation on 2026-08-23: Option A, the
`test` task now carries the permission flags. `deno task test` re-run as
the gate command: 2 passed, 0 failed — verification PASSED.)

What was built (steps 1.1–1.5 all implemented):
- `db/server/schema.sql`, `db/room/schema.sql` — as written, plus the
  step-1.3-sanctioned `branch_name text` column on `event_index`
  (extremities→event_ids map for the send endpoint).
- `api/engine/`: `db.ts` (exact), `room.ts`, `ingest.ts` (algorithm
  verbatim, incl. D1 rejection, per-session client, D6 SET right after
  connect, parameterized commit message, `keepPrevBranches` test hook for
  Phase 2), `mergedriver.ts` (D6 stub verbatim incl. GUARD),
  `timeline.ts`, `auth.ts`.
- Endpoints: createRoom / send / messages / state — all four appear in
  the `Registred ... handler` log lines on server start; **no `main.ts`
  edit was needed**.
- `db-init` task + `db/init.ts` — provisions server DB (verified output:
  `server DB 'postgres' provisioned from db/server/schema.sql`).
- `tests/engine.test.ts` — the invariant test.

Deviations:
- Init-commit baseline: a fresh room DB's `dolt.log` starts with **2**
  implicit commits ("Initialize data repository" + "CREATE DATABASE"),
  not 1 → the commit-count assertion is exactly **7** (2 implicit +
  schema genesis + create event + 3 messages), adjusted ONCE per the
  phase file.
- `timeline.messages`/`stateNow` check out the newest-tip `x*` extremity
  branch before reading: a fresh client lands on `main` (S2 finding),
  and `main` only ever holds the genesis commits — without this, reads
  would not see the event history at all. With multiple extremities
  (mid-fork window) one side's history is read — prototype
  simplification, recorded.
- Read of `dolt.branches` uses its `latest_commit_date` column to pick
  the newest extremity (observed in S2 output).
- `deno.lock` auto-trim on root-level deno runs (as in Phase 0) —
  restored to HEAD.

## Phase 2 log

Status: COMPLETE

What was built:
- `api/engine/canonical.ts` (exact per step 2.1) + `tests/canonical.test.ts`.
- `api/engine/eventid.ts` (`redact` + `eventIdFor` per step 2.2) +
  `tests/eventid.test.ts` (shape, determinism, redacted-content invariance,
  sender sensitivity, member/create content filtering).
- `ingest.ts` step 3 wired: Mode A builds the unsigned PDU
  (`type/room_id/sender/state_key?/content/prev_events/origin_server_ts/
  depth: 0`) and computes the real reference hash; full PDU stored as
  `canonical_json`. Mode B keeps the provisional placeholder.
- `mergedriver.ts` v0 (latest-wins, D4) per step 2.3: both side hashes
  captured pre-merge (scalar-subquery form), state rows read `AS OF` each
  side, contested keys resolved by `(origin_ts, event_id)` latest-wins,
  conflicts cleared `--ours`, D6 GUARD retained; `events` listed in
  `dolt.conflicts` throws a STOP-AND-REPORT error (never fired).
- `tests/merge.test.ts` — fork/merge per step 2.4.

Deviations:
- **D8 rework (see Blockers B3):** ingest is branch-first; prev
  resolution via `event_index.branch_name` + `E_BRANCH_POINTER_DRIFT`
  assertion; `keepPrevBranches` now simply skips prev-branch deletion
  (pointers never move, so kept prevs stay at their own commits). Test
  hook recorded here per step 2.4 NOTE.
- Reference-hash simplification recorded per step 2.2: `hashes` kept
  absent (no content hashes — not federating).
- Known Mode A simplification (recorded): two identical events (same
  redacted fields incl. same `origin_server_ts`) would produce the same
  reference-hash event ID — real Matrix disambiguates via
  auth_events/depth; tests use distinct timestamps.
- `deno.lock` auto-trim on root-level deno runs — restored to HEAD.

Verification: `deno task test` → **10 passed, 0 failed**
(engine invariant + canonical + eventid + fork/merge + demo).
Phase 3 gate evaluation: Phase 2 passed ✓ AND S7 PASS ✓ → proceed to
phase-3.md.

## Phase 3 log

Status: COMPLETE

What was built:
- `ingest.ts` Mode B wire IDs (step 3.1): events row keeps the provisional
  id; the wire id `'$' + commit_hash` is stored in `event_index` (with
  `branch_name` = the provisional-derived branch, per D8) and returned;
  prev resolution works unchanged via `event_index`.
- `timeline.messages` Mode B path: maps commits → events by commit hash
  directly (per-commit `dolt_diff('<c>~','<c>','events')`, `added` row),
  returning `{ ...canonical_json, event_id: '$' + commit_hash }`.
- `tests/modeb.test.ts` — create + 2 messages; every returned event_id
  equals `'$' + <commit_hash>`; messages carry the wire ids. Green.
- `api/engine/sync.ts` — `pushRoom` / `pullRoom` (step 3.2).
- Sync endpoints `_communico/rooms/:roomId/push|pull` (step 3.3) —
  verified in the `Registred ... handler` log lines.
- Second instance (step 3.4): `/tmp/doltgres-b.yaml` (port 5433, data
  `/tmp/doltgres-b-data`, the three `*_file` paths under /tmp), second
  Doltgres + app instance B (ports 8080/8081, `DB_PORT=5433`), `db-init`
  run against B. The permitted `main.ts` edit applied (ports from
  `APP_A_PORT`/`APP_B_PORT`, defaults 80/8000); `db.ts` verified to read
  `DB_PORT`.

Discovered Doltgres behavior (recorded for the gap report):
- `dolt.remote_branches` system table exists and lists remote-tracking
  refs as `remotes/origin/<branch>`; `DOLT_BRANCH('<b>', 'origin/<b>')`
  creates the local branch from it (plain `DOLT_CHECKOUT('<b>')` also
  resolves a remote branch). `dolt.branches` lists LOCAL branches only;
  `DOLT_BRANCH('-r')` → `error: invalid usage`; `DOLT_BRANCH('-a')` →
  `error: unknown option`; **`DOLT_BRANCH('--remotes')` silently creates a
  stray local branch named `s`** (flag-parse quirk — avoid that form).
- **`INSERT ... ON CONFLICT DO NOTHING RETURNING` runs but returns an
  empty rows array** (RETURNING not honored); `rowCount` IS correct
  (1 inserted / 0 conflict-skipped) — `sync.ts` counts new commits via
  `rowCount`.
- `DOLT_PUSH` to a `file://` remote creates the remote directory tree
  itself — no pre-creation needed.

Deviations:
- pushRoom: the phase text said to `Deno.mkdir` the remote parent dir;
  dropped because DOLT_PUSH creates the tree itself (verified) AND the
  sanctioned server permission set (`deno task start`:
  `--allow-net --allow-env --allow-read`) has no `--allow-write` —
  `Deno.mkdir` failed the first demo attempt with `NotCapable: Requires
  write access to "/tmp/communico-remotes"`. No task/signature changes.
- pullRoom event_index rebuild walks `main` + EVERY `x*` branch's
  `dolt_log` (not only `dolt.log` on HEAD): with D8, event commits never
  land on `main`, so HEAD's log would show only genesis commits.
- Stale-branch note (prototype scope, recorded): the remote keeps
  consumed/deleted extremity branches (no remote-side deletion in the
  phase text), and pull mirrors what the remote advertises — repeated
  push/pull cycles across merges can surface stale extremities. Candidate
  gap-report item.

Demo transcript (step 3.5 verification, actual output):

```
A createRoom => 200 {"room_id":"!5298cc45-51d5-4b6e-9ce6-5715dd76a9ef:localhost"}
A send => 200 {"event_id":"$0t2c4a6kgiqqjmg6kj78bfi6nfolcdgs"}
A push => 200 {"ok":true}
A room_directory db_name => room_7fddb6a15fde05d4f6a1
B pull => 200 {"new_commits":2} (wall 408 ms)
B messages => 200 {"chunk":[
  {"type":"m.room.message","content":{"body":"hello from A"},
   "event_id":"$0t2c4a6kgiqqjmg6kj78bfi6nfolcdgs", ...},
  {"type":"m.room.create","content":{"creator":"@dev:localhost",
   "room_version":"test.communico.dolt.v1"},
   "event_id":"$gbq4tumroe5p147f87urdsfvvqf72jrg", ...}]}
DEMO PASS: true   (B's /messages output contains "hello from A")
```

- Pull sync wall time: **408 ms**, `new_commits`: **2**.
- Full suite after Phase 3: `deno task test` → 11 passed, 0 failed.

## Phase 4 log

Status: COMPLETE

- `tests/bench-ingest.ts` (plain script per step 4.1):
  run 1: 25664 ms → **7.8 events/sec**, last event 130.1 ms;
  run 2 (events 210–409): 26812 ms → **7.5 events/sec**, last event
  138.1 ms; ratio 0.96.
- `tests/reject.test.ts` (step 4.2): 3 extremities via the
  `keepPrevBranches` hook (E1/E2 keep, E3 consumes); 3-prev ingest throws
  `M_TOO_MANY_PREV_EVENTS…`; commit census across all branches unchanged;
  extremity set unchanged. Green.
- Gap report filled (below).
- Full suite: `deno task test` → 12 passed, 0 failed.
- Phase 3 was executed (not skipped — S7 PASSed).

## Blockers

### B3 — `keepPrevBranches` as written cannot fork: committing advances the prev branch's pointer (RESOLVED by D8)

**RESOLVED 2026-08-23 by decision D8** (validator session
ses_fd2add951ffer9kl2Zf8K1WwZI under user delegation; recorded in
plan.md §9): Option C + rider. Ingest is now branch-first: base checkout
→ `DOLT_CHECKOUT('-b', '<newBranch>')` BEFORE any merge or write →
merge→insert→commit all land on the NEW branch; prev pointers never move.
Rider: `event_index.branch_name` is mandatory; prev resolution (step 4)
goes through it (not `branchNameFor` recomputation) with the executable
invariant `(SELECT HASHOF(branch)) == commit_hash`, else
`E_BRANCH_POINTER_DRIFT`; 2-prev order = base checkout → create/checkout
new branch → mergeDriver(branch_1) on the new branch. Phase files updated
by the decider (phase-1 steps 4–10 + DDL + send row; phase-3 step 3.1 +
pull-rebuild). After the rework: Phase 1 invariant test stayed green and
the Phase 2 fork/merge test passed (E3 = exactly 2 parents).
Original record below.

**Exact instruction:** phase-1 step 8 (create new extremity branch at HEAD
AFTER the commit, on the checked-out prev branch) + phase-2 step 2.4 NOTE
(`keepPrevBranches` = skip deleting the prev branches in step 8).

**Observed failure:** `tests/merge.test.ts` —
`assertEquals(parents.size, 2, 'E3 commit must have exactly 2 parents')`
→ actual 1, expected 2.

**Root cause (verified against the room DB):** ingest checks out the prev
branch and commits there, so the commit ADVANCES the prev branch pointer
to the child commit. E2a (keepPrevBranches) left branch `x<E1>` existing
but pointing at E2a's commit; E2b then built on `x<E1>` ⇒ linear history
create→E1→E2a→E2b→E3 (verified via `dolt_log` on the final branch — no
merge commit anywhere). When E3 merged `x<E2b>` into `x<E2a>`, `x<E2b>`
was already a descendant → `Everything up-to-date`, E3 landed as a
1-parent commit. The phase-2 note's intent (E2a and E2b share prev E1, a
real fork) cannot happen as written: skipping deletion keeps the NAME but
not the POINTER.

**Fix options presented to the decider (user stepped away):**
- **C (recommended):** create + check out the new extremity branch BEFORE
  the commit (Mode A event IDs are reference hashes — known pre-commit),
  so the commit lands on the new branch and prev pointers never move.
  Uniform for 1-prev and 2-prev (merge commit's parents = prev0/prev1
  tips, both unmoved); no new DOLT forms needed. Deviation: reorders
  phase-1 step 8's create/checkout ahead of step 7's commit; all
  observable invariants unchanged (Phase 1 test still passes; note: with
  this order `main` stays at the schema-genesis commit instead of the
  create-event commit — both readings of "leave main where it is" are
  defensible; the commit-count assertion is unaffected).
- **A:** keep the written order; when `keepPrevBranches` is set, restore
  each kept prev branch to its event's commit hash afterwards
  (`DOLT_BRANCH('-f', name, hash)` or delete+recreate-at-hash — exact form
  to be discovered). More moving parts, new DOLT form to discover.

**Status:** recorded, reported to the decider session; awaiting decision.
Phase 2 gate not met as written.
### B2 — `deno task test` cannot run DB-touching tests as written (RESOLVED by D7)

**RESOLVED 2026-08-23 by decision D7** (decided by the validator session
ses_fd2add951ffer9kl2Zf8K1WwZI under user delegation; recorded in
plan.md §9): Option A — the root `deno.json` `test` task became
`deno test --env --allow-net --allow-env --allow-read tests/*` (one-line
edit). Rationale: plan.md §4 requires every commit green via
`deno task test`, so the task itself must carry the permissions its tests
need; the flag set matches what the phase files prescribe for `db-init`
and the Phase 4 bench. `deno task test` re-run as the gate command after
the edit: 2 passed, 0 failed. Original record below.

**Exact command** (phase-1 step 1.5 verification):
```
deno task test          # = deno test tests/*
```

**Full error output (essential frames):**
```
error: (in promise) NotCapable: Requires env access to "USER", run again
with the --allow-env flag
    at denoEnvGet (ext:deno_node/_process/process.ts)
    at Object.<anonymous> (…/npm/registry.npmjs.org/pg/8.16.3/lib/defaults.js:8:75)
…
./tests/engine.test.ts (uncaught error)
FAILED | 1 passed | 1 failed
```
The `pg` npm package reads process env at import time, and the test needs
net access to reach Doltgres; the pre-existing `test` task
(`deno test tests/*`, written when the only test was a pure `assertEquals`
demo) grants no permissions, so any test importing the engine fails before
running.

**What I tried:**
- Same failure reproduced with a minimal test that only imports `pg`
  (proves it's the task definition, not the engine code).
- Full suite with explicit flags:
  `deno test --env --allow-net --allow-env --allow-read tests/*` →
  **2 passed, 0 failed** — including `engine invariant: commit = event`
  (all Phase 1 assertions green: 7 commits, per-event-commit diff of
  exactly 1 added `events` row, newest-first messages, one `x*` branch).
  Run as diagnostic evidence only; the phase gate (`deno task test`) is
  NOT claimed passed.
- The phase files themselves use exactly this flag set for DB-touching
  scripts (`db-init` in step 1.4; the Phase 4 bench header) — the `test`
  task predates DB tests.

**Decision needed:** bless updating the `test` task to
`deno test --env --allow-net --allow-env --allow-read tests/*` (one-line
change to the repo's task definition — not on the never-modify list, but
not sanctioned by the phase file either, so per hard rule 2 I stopped).
Alternative: leave the task alone and treat
`deno test --env --allow-net --allow-env --allow-read tests/*` as the
recorded verification command (deviation noted here).

### B1 — S3 keystone: conflicted merges impossible in autocommit mode (RESOLVED by D6)

**RESOLVED 2026-08-23: user decision D6 sanctioned the session-variable
mechanism (Path B below); README "Doltgres conventions" updated; phase-0
S3 steps revised; S3 re-run PASSes. Record kept for history — the
underlying limitation feeds the gap report.**

Original record:

**Exact command** (phase-0 S3 step 5, all three originally-listed forms):
```sql
SELECT DOLT_MERGE('--no-commit', 'mb');   -- listed primary
SELECT DOLT_MERGE('mb', '--no-commit');   -- listed alternate A
SELECT DOLT_MERGE('mb');                  -- listed alternate B
```
Context: on `spike_room1`, branch `ma`; `ma`/`mb` diverged with
conflicting updates to the same row (`state.k='topic'`: 'cats' vs 'dogs').

**Full error output (identical for all three forms):**
```
error: Merge conflict detected, @autocommit transaction rolled back.
@autocommit must be disabled so that merge conflicts can be resolved using
the dolt_conflicts and dolt_schema_conflicts tables before manually
committing the transaction. Alternatively, to commit transactions with
merge conflicts, set @@dolt_allow_commit_conflicts = 1
```

**Meaning:** without the session variable, Doltgres cannot hold an
unresolved-conflict merge state across statements in autocommit mode; the
merge errors and rolls back, `dolt.conflicts` stays empty, and a
subsequent commit is a plain 1-parent commit. Non-conflicting
(fast-forward / clean auto-merge) merges work fine in autocommit.

**Diagnostic evidence gathered (scratch DBs, dropped afterward):**
- Path A (explicit transaction: `BEGIN` → merge → resolve → update →
  `DOLT_COMMIT` → `COMMIT`) lands a correct 2-parent merge commit with
  dictated content; violates the README's no-transactions convention.
- Path B (`SET dolt_allow_commit_conflicts = 1;` — plain Postgres `SET`;
  `@@` form is a syntax error; `set_config()` rejected) holds the
  conflict state in the session and lets resolve→update→`DOLT_COMMIT`
  land the 2-parent merge commit with dictated content in autocommit
  mode. Session-scoped; held state dies at disconnect;
  `DOLT_COMMIT('--amend')` mid-merge errors ("cannot amend").
  **D6 = Path B.**

**Side discovery (planner bug, gap-report material):**
`SELECT * FROM dolt.commit_ancestors WHERE commit_hash = HASHOF('ma');`
fails with `error: result max1Row iterator returned more than one row`
when the branch tip is a merge commit; scalar-subquery form
`WHERE commit_hash = (SELECT HASHOF('ma'))` works. `AS OF HASHOF('ma')`
unaffected.

## Client-demo Phase 3 log

Status: COMPLETE

What was built:
- `demo/setup.sh` (step 3.1): preflight, image build, container with the
  exact capped `docker run`, Doltgres+app readiness waits, `db-init`,
  Mode B demo room (reuses the newest native room on re-runs),
  matrix-commander image, non-interactive alice+bob logins, summary with
  copy-paste Act 1/Act 2 commands. Idempotent; `--reset` tears down.
- `demo/run-demo.sh` (step 3.2): interactive choreography print;
  `--check` headless self-test; `--scripted` host-side tmux 3-pane
  choreography (Q5/A).
- `demo/inspection-tour.md` (step 3.3): 8 shape-based stops +
  `demo/fork-demo.ts` (real fork+merge via `keepPrevBranches`).
- `demo/README.md` (step 3.4): prereqs, quickstart, the two-paragraph
  claim, pointers.
- `### nio-compat findings` gap addendum (step 3.5.1) appended under
  `## Gap report`.

Deviations / substitutions (all recorded where they happened):
- **Q5/A (validator decision under user delegation):** `--scripted`'s
  tmux runs ON THE HOST (`/usr/bin/tmux` 3.7b) — verified the container
  has no docker CLI and no `/var/run/docker.sock`, so container-side
  tmux cannot run matrix-commander panes at all. phase-3 step 3.2 was
  rewritten by the decider; the earlier PERMITTED container-side tmux
  install (`docker exec -u root communico-dev apt-get install -y tmux`)
  already happened and is recorded here as unused/harmless (ephemeral
  container layer). Session: `communico-demo` (listener = alice's real
  client `docker run … --listen forever`, watch = `docker exec … deno
  eval` dolt.log poll, sender lane = 4 paced sends ~3 s apart). Verified
  end-to-end: all 3 panes alive, `/tmp/demo-listen.log` shows the four
  paced messages received by alice's client.
- setup.sh fixes found by the rehearsal: (a) `Deno.readAll` no longer
  exists in Deno 2 — room id extracted with grep/cut instead; (b)
  `ORDER BY ctid` unsupported/ absent in Doltgres — "newest native room"
  now resolved via `MAX(seq)` in `event_index` (both scripts);
  (c) matrix-commander refuses `--login` when credentials exist (E224)
  and stale stores hold old since-tokens — setup drops store +
  credentials via a throwaway container rm (files are root-owned);
  (d) `--listen once` prints no event id in default output — `--check`
  uses `--output json` so the `\$[a-z0-9]{32}` grep can match.
- Fresh-clone rehearsal (step 3.5.2) was run as a `cp -a` of the working
  tree to `/tmp/fresh-communico` instead of `git clone -b
  spike/matrix-client-demo` — hard rule 3 (no commits) means a git clone
  would carry none of the uncommitted work; the copy reproduces the
  fresh-state substance. The true git-clone rehearsal belongs to
  validation time after commits land (the phase labels this gate "for
  validation").
- Insurance: `docker commit communico-dev communico-dev-backup:
  pre-rehearsal` was taken before the rehearsal removed the container
  (the room-engine spike databases lived inside it).

Rehearsal transcript (final, after all reworks):
```
$ docker rm -f communico-dev; bash demo/setup.sh
  => exit 0 (image present; container created with caps; Doltgres ready;
     app ready; db-init seeded; room created; alice+bob logged in;
     summary with room id + Act1/Act2 commands printed)
$ bash demo/run-demo.sh --check
  >> Act 1: bob sends 'check-…'  => sent as event "$<32 hex chars>"
  >> Act 2: alice listens once
     body found in alice's output ✓
     event id '$<32 chars>' (= Dolt commit hash) found ✓
  CHECK: PASS   => exit 0
$ bash demo/run-demo.sh --scripted   (earlier, also verified)
  => host tmux 'communico-demo' up; /tmp/demo-listen.log shows
     "three: state at any commit via AS OF",
     "four: federation is a dolt pull" received from bob ✓
```

Final state: `deno task test` → 13 passed, 0 failed. Main-repo demo
environment recreated (`demo/setup.sh` exit 0).

## Client-demo Phase 2 log

Status: COMPLETE

What was built:
- `event_index.seq` (step 2.1): **fallback rung 2 adopted universally** —
  `CREATE SEQUENCE IF NOT EXISTS event_seq` + `seq bigint DEFAULT
  nextval('event_seq')`. Rung 1 (`bigserial`) works only via CREATE TABLE
  in Doltgres; the ALTER path is broken by two quirks (recorded below).
- `api/engine/syncfeed.ts` (step 2.2): since-tokens, initial/incremental
  sync, 500 ms long-poll on `MAX(seq)`, all-rooms join map.
- `api/endpoints/_matrix/client/v3/sync/get.ts` (step 2.3): real
  syncfeed internals behind the step-1.5b route (Q4 guard-rail honored:
  Act 1 re-verified after the swap — transcript below).
- `POST /_matrix/client/v3/keys/upload` stub (step 2.4; the ONLY keys
  endpoint the capture lists — returns `{one_time_key_counts:{}}`).
- `tests/sync.test.ts` (step 2.5): initial/incremental/long-poll — green;
  full suite 13/13.

Doltgres discoveries (gap-report material):
- `ALTER TABLE ... ADD COLUMN seq bigserial` creates the sequence but
  does NOT attach the nextval default (`column_default` = NULL), and
  every `nextval()` use against the `bigserial`-typed column errors:
  `ASSIGNMENT_CAST: target is of type bigserial but expression is of
  type bigint` — even with an explicit `::bigserial` cast (which Doltgres
  rewrites to `::BIGINT`). The `bigserial` pseudo-type is effectively
  unusable outside CREATE TABLE; plain `bigint + nextval default` (rung
  2) behaves normally everywhere. `CREATE SEQUENCE [IF NOT EXISTS]` works.
- `information_schema.columns.column_default` reports NULL even where a
  default functions (reporting gap).

Deviations:
- `syncSince` state.events on initial sync: built from the state-type
  events of the SAME loaded event set (wire ids intact) instead of the
  phase text's "state table rows as events" — the state table stores the
  PROVISIONAL Mode B event id, which cannot be resolved to the wire id
  without a fragile message-text join; the sets coincide for the demo
  flows (create + member [+ topic]). Recorded.
- Incremental sync's join map contains only rooms with new events
  (initial sync: every `room_directory` row). Recorded.
- `tests/bench-ingest.ts` now chains via `latestExtremityEventId` (member
  event baseline) — it also executes under `deno task test` (the
  `tests/*` glob); green, adds ~10 s per run.
- Sequence name correction: Postgres-style `<table>_<column>_seq` =
  `event_index_seq_seq` (my initial backfill attempt used the wrong name
  before rung 2 was adopted).

Act 1 re-verification (Q4 guard-rail, after the syncfeed swap):
```
$ matrix-commander -m "act1 re-verify after sync swap" --room '!73b4…' --plain
  => exit 0, sent as event "$u28rq0vbllog9kthp4bco09916n38hv5"
  server log: GET /v3/sync?since=s0&full_state=true&timeout=30000 (3565 ms)
  (note: since=s0 came from the phase-1 static next_batch persisted in
  the client store — parsed as 0, harmless)
```

Act 2 verification transcript (step 2.6, end-of-chain):
```
terminal 1 — alice:
$ matrix-commander --login password ... (@alice:localhost) => exit 0
$ matrix-commander --listen forever --plain &
  => "This program is ready and listening for its Matrix messages."
terminal 2 — bob:
$ matrix-commander -m "hello alice via doltgres" --room '!73b4…' --plain
  => exit 0, sent as event "$kdhpdnvjtasmo5udtl88k2n9jlq5nknr"
terminal 1 prints (within the long-poll window):
  message_callback(): … event_id: $kdhpdnvjtasmo5udtl88k2n9jlq5nknr,
    event: @bob:localhost: hello alice via doltgres
  Message received for room @dev:localhost [!73b4457d…] | sender bob
    [@bob:localhost] | 2026-08-23 19:00:24 | hello alice via doltgres
server log (the sync loop working):
  GET /v3/sync?full_state=true
  GET /v3/sync?since=s983&full_state=true&timeout=30000 - 73ms
  GET /v3/sync?since=s984&timeout=30000 - 19728ms   (long-poll → message)
  GET /v3/sync?since=s985&timeout=30000 - 30491ms   (timeout → empty)
```
PASS: the printed event id is the Mode B wire id `'$' + <32-char dolt
commit hash>` and matches bob's send response exactly.

## Client-demo Phase 1 log

Status: COMPLETE

What was built:
- Sanctioned framework diff (step 1.1, exact): `search: URLSearchParams`
  on `TApiComponentRequest` + population in `api.ts`. Nothing else in
  those files. `deno task test` stayed green (12).
- Users/passwords (step 1.2): `users.password_hash`, seeds for
  `@alice:localhost` / `@bob:localhost` (sha256 of `demo-password`,
  documented prototype-grade), `access_tokens.device_id`.
- Endpoints (step 1.3): `GET /_matrix/client/versions`,
  `GET/POST /_matrix/client/v3/login`, r0 alias `GET
  /_matrix/client/r0/login` (the ONLY r0 path per capture conclusion 1),
  `GET /_matrix/client/v3/account/whoami` (pulled forward from phase-2
  step 2.4 — capture lists it in the critical path: `restore_login`
  calls it on every authenticated invocation).
- `auth.ts` (step 1.4): Bearer header OR `?access_token=` query param.
- Creator membership event (step 1.5): `createRoom` now ingests
  `m.room.member` (join) after `m.room.create`, returns
  `{createEventId, memberEventId}`; test ripple applied
  (`tests/util.ts` with `latestExtremityEventId`/`resetRoom`; engine
  count assertion 7→8; per-commit diff checks 5 event commits;
  merge/modeb/reject chain off the member event). 12/12 green.
- Minimal /sync (step 1.5b, decision Q4/A): near-static join map naming
  every `room_directory` row, constant `s0` tokens — nio's `room_send`
  needs the room in `self.rooms`, populated from `rooms.join`.
  Acknowledged throwaway internals; phase-2 replaces them.

Deviations / substitutions (all capture- or Doltgres-driven):
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (the phase's own fallback
  line) is NOT supported by Doltgres
  (`error: IF NOT EXISTS on a column in an ADD COLUMN statement is not
  supported yet`), and plpgsql `DO` blocks also fail
  (`at or near "do": syntax error`). Substitution: columns live in the
  CREATE TABLEs (fresh provisioning path); the existing dev DB got
  one-off plain ALTERs; documented in schema.sql comments.
- Seed INSERTs gained explicit column lists (positional INSERTs broke
  after the table gained a column: `number of values does not match`).
- Login POST error shape: framework 400 via throw (nio maps any non-2xx
  to LoginError and reports cleanly) — the 403+M_FORBIDDEN variant was
  not needed.
- Commit messages for Mode B embed the PROVISIONAL event id, not the
  wire id (self-reference: the wire id IS the commit hash, which does
  not exist until after the commit). The step-1.6 criterion "newest
  dolt.log message = event $<hash> type m.room.message" was verified as:
  message matches `event $<id> type m.room.message` AND the commit's
  `commit_hash` equals the client-printed event id
  (`nno29u7fo0a28436g7slln2gfh7ik8rp` == client event id ✓).
- Q4 resolution recorded: minimal /sync as step 1.5b (Option A), phase
  files updated by the decider; guard-rail: re-verify Act 1 after
  phase-2's syncfeed swap (done — see Phase 2 log).

Act 1 verification transcript (step 1.6, end-of-chain):
```
$ curl -X POST localhost:80/_matrix/client/v3/createRoom ... 
  => {"room_id":"!73b4457d-1c9a-4fdf-ba39-2b766b8918b7:localhost"}
$ matrix-commander --login password ... (bob)
  => exit 0, "Log in using method 'password' was successful"
$ matrix-commander -m "real client, real commits" --room '!73b4...' --plain
  => exit 0, sent as event "$nno29u7fo0a28436g7slln2gfh7ik8rp"
  server log: GET whoami 200; POST keys/upload (404, tolerated);
              GET /v3/sync?full_state=true&timeout=30000 200;
              PUT /v3/rooms/!/send/m.room.message/<uuid> 200
DB checks (room_99d1cd753246efaf3bf1, extremity branch):
  newest canonical_json body = "real client, real commits" ✓
  newest dolt.log: commit_hash = nno29u7fo0a28436g7slln2gfh7ik8rp
    (= client-printed event id — Mode B kicker) ✓
    message = "event $fb9e6046-… type m.room.message" (provisional id) ✓
```

## Client-demo Phase 0 log

Status: COMPLETE

What was done:
- Flows exercised per phase-0 step 0.1 against App A inside
  `communico-dev`; captures in `demo/capture/`: `raw-login.log`,
  `raw-listen.log`, `raw-tail.log`, `raw-server.log`, and the deliverable
  `endpoints-capture.md` with the five conclusions answered.
- Capture sources used: (1) server console — yes; (2) client
  `--debug --verbose --verbose` logs — yes; (3) http-debug-proxy —
  SKIPPED (sources 1+2 plus client source inspection answered the
  conclusions for the only flow that reaches the wire today; the
  remaining flows are re-run after Phase 1 per step 0.1's own escape
  hatch); plus (4) matrix-commander/matrix-nio source read inside the
  image as a corroborating source (rows marked [wire] vs [source] in the
  capture doc).

Deviations:
- `docker run` invoked WITHOUT `-it` (no TTY in the executor shell);
  batch flows are non-interactive — no behavioral impact. Recorded.
- Send flow was not run as a separate step: like listen/tail it aborts
  client-side (`E153: Credentials file was not found`) because login
  404s. Phase-0 anticipated this; the full wire re-run happens after
  Phase 1 and `endpoints-capture.md` has a "Pending" section for it.

Key findings (driving Phases 1–2): r0 alias needed ONLY for
`GET /login`; everything else is `v3`; auth token travels as
`?access_token=` query param (never a Bearer header) in matrix-nio;
`/versions` is never called; `POST /v3/keys/upload` WILL be called at
first sync (nio constructed with encryption_enabled=True + a store);
`/sync` params = `access_token`, `timeout`, `full_state`, `since`.

## Gap report — Dolt-as-is vs a Dolt-native Matrix homeserver

Prototype: communico dolt-room-engine, phases 0–4, 2026-08-23.
Doltgres version: Doltgres version 1.2.0 (`SELECT version();` → PostgreSQL 15.5).

### Confirmed working (with discovered syntax)
- db-per-room: `CREATE DATABASE <name>` over the PG wire; per-db clients;
  branch-addressed connect (`database: '<db>/<branch>'`) works,
  `active_branch()` confirms.
- branch-per-extremity: `DOLT_BRANCH/DOLT_CHECKOUT/DOLT_COMMIT/DOLT_BRANCH('-D',b)`
  all work; **session scope: a fresh client always starts on `main`**, so
  one dedicated client + explicit checkout per operation is sufficient.
- merge-driver seam (2-parent merge with driver-dictated content): works
  via `SET dolt_allow_commit_conflicts = 1;` then
  `DOLT_MERGE('<b>')` (returns `("",0,1,"conflicts found")`, conflict state
  held in-session) → `DOLT_CONFLICTS_RESOLVE('--ours', '<t>')` → driver
  `UPDATE`s → `DOLT_COMMIT('-Am', ...)` — verified 2 parents in
  `dolt.commit_ancestors` and dictated content live + `AS OF` (D6).
- state-at-event via AS OF + dolt_diff: `SELECT * FROM t AS OF '<commit>'`,
  `dolt_diff(from,to,'t')`, `dolt_diff_stat(from,to,'t')` all work;
  `dolt_log('<branch>')`, `dolt.log`, `dolt.branches`, `dolt.conflicts`,
  `dolt.commit_ancestors`, `dolt.remotes`, `dolt.remote_branches` all
  queryable.
- jsonb (top rung: `doc->'a'->>'b'`), recursive CTEs, PL/pgSQL functions
  all work natively (S6).
- pull-based room sync via file remote: `DOLT_REMOTE('add',...)`,
  `DOLT_PUSH('origin','<b>')` (main + `x*` extremity branches),
  `DOLT_CLONE(url, name)`, `DOLT_PULL('origin')`, `DOLT_FETCH()`;
  remote-tracking refs enumerated via `dolt.remote_branches`, local
  branches materialized with `DOLT_BRANCH('<b>', 'origin/<b>')`. Full
  two-instance demo passed (Phase 3): room replicated, message visible on
  the pulling instance.

### Gaps (things Dolt/Doltgres would need for full native Matrix support)
1. N-parent commits: Matrix allows up to 20 prev_events per event; Dolt
   merges are 2-parent. Prototype restricted to ≤2 (decision D1).
   Evidence: `error: Error: Dolt does not support merging from multiple
   commits. You probably meant to checkout one and then merge from the
   other.` (verbatim, S4).
2. Conflicted merges cannot be staged in autocommit mode at all — without
   `dolt_allow_commit_conflicts=1` the merge statement rolls back and no
   conflict state survives the statement boundary (B1 error verbatim in
   Blockers). The session variable fully unblocks the driver pattern, but
   it is a non-obvious, session-scoped requirement with a footgun: the
   held merge state dies at disconnect mid-merge. A first-class
   "begin merge / resolve / commit merge" workflow (or clear docs) would
   help.
3. Planner bug: `WHERE commit_hash = HASHOF('<ref>')` errors with
   `result max1Row iterator returned more than one row` when the ref
   points at a merge commit; the scalar-subquery form
   `(SELECT HASHOF('<ref>'))` is required. `AS OF HASHOF('<ref>')` is
   unaffected.
4. `INSERT ... ON CONFLICT DO NOTHING RETURNING` executes but returns an
   empty rows array (RETURNING not honored); `rowCount` is correct.
5. `DOLT_BRANCH('--remotes')` silently creates a stray local branch named
   `s` instead of listing remote branches (flag-parse quirk);
   `DOLT_BRANCH('-r')` / `('-a')` error. Remote enumeration works via the
   `dolt.remote_branches` table instead.
6. Remote branch lifecycle: there is no push-side branch deletion /
   advertisement pruning in the file-remote flow we used, so consumed
   extremity branches linger on the remote and re-materialize on pull
   (observed as a prototype note; Matrix extremity semantics would need
   either remote branch deletion or an explicit extremity-advertisement
   layer).

### Documented properties (not gaps)
- History immutability: redacted/erased content persists in historical
  commits and clones (decision D2 — accepted, to be documented for
  operators).

### Measurements
- Sequential ingest: 7.8 events/sec run 1, 7.5 events/sec run 2,
  last-event latency 138.1 ms (run2/run1 ratio 0.96 — mild degradation
  across 400 events).
- Pull sync: 408 ms wall for 2 new_commits (full-room clone + reindex of
  the demo room).

### nio-compat findings (matrix-client-demo addendum)

What it took to drive an unmodified matrix-nio client
(matrix-commander, nio 0.25.2) against communico/Doltgres — full capture
in `demo/capture/endpoints-capture.md`:

- **Auth on the wire is the Bearer HEADER, not `?access_token=`**: nio's
  Api layer builds paths with the query param, but `AsyncClient.send()`
  rewrites them to `Authorization: Bearer` before sending. Server must
  accept the header; accepting both is useful (curl).
- **Path split**: `GET /_matrix/client/r0/login` is hardcoded in
  matrix-commander's login probe (the ONLY r0 call); everything nio
  issues is `v3`.
- **Critical-path endpoints for a minimal server**: `GET r0/login`,
  `POST v3/login`, `GET v3/account/whoami` (called by `restore_login` on
  EVERY authenticated invocation — easy to miss), `GET v3/sync` (needed
  even to SEND: nio's `room_send` resolves the room client-side from the
  sync's `rooms.join` map), `PUT v3/rooms/:id/send/:type/:txn`.
  `POST v3/keys/upload` fires on every authenticated startup when nio is
  constructed with encryption enabled + a store; a stub or a tolerated
  404 both keep the flow alive. `/versions` is never called by these
  flows.
- **Minimal sync shape that satisfied matrix-nio**: top-level
  `next_batch`, `rooms.join.<id>.timeline.events[]` with per-event
  `{event_id, sender, type, content, origin_server_ts, state_key?}`,
  plus empty `presence/account_data/to_device/device_lists/
  device_one_time_keys_count` maps; `since` token as an opaque string
  (`s<seq>` here); long-poll honored via server-side wait on
  `MAX(seq)`.
- **Doltgres-specific findings surfaced while building this**:
  `bigserial` is only usable via CREATE TABLE (ALTER path loses the
  default; `ASSIGNMENT_CAST` rejects nextval's bigint against the
  bigserial type everywhere else) — use plain
  `bigint + DEFAULT nextval('<seq>')`; `ALTER ... ADD COLUMN IF NOT
  EXISTS` unsupported; plpgsql `DO` blocks unsupported;
  `information_schema.columns.column_default` under-reports.


