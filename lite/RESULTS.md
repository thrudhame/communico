# communico-lite capability matrix & execution log

DoltLite **v0.11.53** (SQLite 3.54.0, 64-bit) — user-local binary at
`lite/bin/doltlite` (asset `doltlite-tools-linux-x64-0.11.53.zip` from
github.com/dolthub/doltlite/releases/tag/v0.11.53; no root, no system
install). Native spikes run with `bash lite/spikes/native/run.sh`;
scratch DBs and per-spike logs in `/tmp/lite-spikes/` (runner recreates
them fresh each run; LS5 intentionally reuses LS4's db per the phase
file).

## L0 capability matrix (native, CLI)

| Spike | Proves | Status |
|---|---|---|
| LS1 basics | config, schema, commit, log, version, json1 | PASS |
| LS2 branch ops | `dolt_branch`, `<db>@branch` open, hashof unmoved, delete | PASS |
| LS3 merge driver (**keystone**) | explicit-txn conflict model, driver-resolved 2-parent merge | **PASS** |
| LS4 branch-first ingest (D8) | commit-per-event on extremity branch, prev unmoved | PASS |
| LS5 time travel | `dolt_at_*`, `dolt_history_*`, `dolt_diff_*`, `dolt_hashof_db()` | PASS |
| LS6 dialect (informational) | json1 round-trip, `dolt_docs`, rowid behavior | PASS |

**Gate to L1: LS1–LS5 all PASS → gate MET.**

## LS1 — basics

Status: PASS

Discovered syntax (all primary forms worked verbatim):
- `SELECT dolt_config('user.name','POC');` → `0`. Dot-commands
  `.headers on` / `.mode list` honored by the CLI shell.
- Schema per phase file (SQLite dialect: TEXT/INTEGER, JSON as TEXT).
- `SELECT dolt_commit('-Am','ls1');` → returns **40-hex** commit hash
  (git-SHA1 style, NOT Doltgres' 32-char base32).
- `SELECT * FROM dolt_log;` → columns
  `commit_hash|committer|email|date|message`.
- `SELECT dolt_version();` → `v0.11.53`.
- `SELECT json_extract(canonical_json,'$.type') FROM events;` → works.

Notes:
- A fresh db has exactly **1** implicit commit ("Initialize data
  repository", committer `doltlite`) — Doltgres had 2.
- **`SELECT dolt_config(...)` (2-arg SET form) is SESSION-SCOPED**: set
  in one CLI invocation, a later invocation reads back defaults
  (`user.name` → `doltlite`, `user.email` → empty). Verified on a
  scratch db. Engine-lite must set config on the SAME connection that
  commits.

Raw results block (final run):
```
- dolt_config user.name/user.email → 0/0 (header rows printed: dot-commands work)
- dolt_commit('-Am','ls1') → 89778bc3a298609b3cc290de28c4bfb7ed54d892
- dolt_log: 89778bc3…|doltlite||…|ls1   +   1feca2a5…|Initialize data repository  (log_rows=2)
- dolt_version() → v0.11.53
- json_extract(canonical_json,'$.type') → m.room.message
```

## LS2 — branch ops

Status: PASS

Discovered syntax:
- `SELECT dolt_branch('x1');` → `0`.
- **Branch-qualified open WORKS**: `doltlite '<dbfile>@x1'` opens on
  branch x1; `SELECT active_branch();` → `x1`. Commits land on x1.
- `SELECT dolt_hashof('main');` on the default open → unchanged after
  the x1 commit (prev-pointer discipline holds at the CLI level).
- `SELECT * FROM dolt_branches;` → columns
  `name|hash|latest_committer|latest_committer_email|latest_commit_date|latest_commit_message|remote|branch|dirty`.
- Branch deletion: `SELECT dolt_branch('-d','x1');` on an UNMERGED
  branch fails verbatim: `Error near line 1: branch is not fully
  merged`. After merging x1 into main (fast-forward,
  `SELECT dolt_merge('x1');` → returns the merge/tip hash), `-d`
  succeeds. **The `-D` force flag EXISTS and works**
  (`SELECT dolt_branch('-D','x2');` → `0`, branch gone) despite the
  DoltLite README documenting only `-d` — extremity cleanup of unmerged
  branches is possible.

Raw results block (final run):
```
- h0 (main) = a50dea901f4c8e974925fa0bd188558bdfce4a10
- @x1: active_branch()=x1; commit → 681b6eb943206045bce75ed39214c84b53ec21ef
- hashof('main') after x1 commit = a50dea90… (unmoved)
- dolt_branches: main|a50dea90…|ls2 base  +  x1|681b6eb9…|ls2 on x1
- dolt_branch('-d','x1') unmerged → Error near line 1: branch is not fully merged
- dolt_merge('x1') on main → 681b6eb9… (ff); dolt_branch('-d','x1') → 0
- dolt_branch('-D','x2') unmerged → 0; dolt_branches afterwards: main only
```

## LS3 — merge driver (KEYSTONE)

Status: **PASS** — the merge-driver seam works on DoltLite v0.11.53.

Discovered syntax / behavior (verbatim from the spike log):
- **Negative control (autocommit):** `SELECT dolt_merge('mb');` outside
  a transaction errors and rolls back:
  ```
  Error near line 1: cannot merge: conflicts detected, autocommit transaction rolled back. Run the merge inside BEGIN/COMMIT to inspect dolt_conflicts and dolt_schema_conflicts, resolve with dolt_conflicts_resolve(), then commit with dolt_commit(). Conflicts are never committed as conflicts
  ```
  Working state is untouched afterwards (content still 'cats').
- **Explicit-transaction sequence (WORKS, final form):**
  ```sql
  BEGIN;
  SELECT dolt_merge('mb');            -- error-LINE "Merge has 1 conflict(s). Resolve and then commit with dolt_commit." BUT conflict state is HELD; subsequent statements run
  SELECT * FROM dolt_conflicts;       -- state|1
  SELECT * FROM dolt_conflicts_state; -- detail row (columns below)
  SELECT dolt_conflicts_resolve('--ours','state');  -- → 0
  UPDATE state SET content='DRIVER-DECIDED' WHERE type='m.room.topic';
  SELECT * FROM dolt_conflicts;       -- GUARD: empty (COUNT(*)=0)
  SELECT dolt_commit('-Am','ls3 merge with driver content');  -- INSIDE the txn; returns merge hash
  COMMIT;                             -- errors "cannot commit - no transaction is active" (harmless; see ordering note)
  ```
- **ORDERING DISCOVERY:** `dolt_commit` INSIDE `BEGIN..COMMIT` finalizes
  the SQL transaction itself; a trailing `COMMIT` then errors
  `cannot commit - no transaction is active`. The variant documented in
  the db's built-in `dolt_docs`/AGENT.md — `COMMIT;` **then**
  `SELECT dolt_commit('-Am', ...);` — ALSO works (merge metadata
  survives COMMIT in-session; verified on a second branch pair with
  content 'DOC-ORDER-OK' and both parents reachable). Canonical form
  for engine-lite: keep the phase ordering (dolt_commit inside), drop
  the trailing COMMIT, or use the documented COMMIT→dolt_commit form;
  both recorded working.
- `dolt_conflicts` columns: `table|num_conflicts`.
  `dolt_conflicts_state` columns: `from_root_ish|base_type|
  base_state_key|base_event_id|base_content|our_type|our_state_key|
  our_event_id|our_content|our_diff_type|their_type|their_state_key|
  their_event_id|their_content|their_diff_type|dolt_conflict_id`.
- The CLI shell **continues executing heredoc statements after a
  statement errors**, and the process exit code is 1 if ANY statement
  errored — runners must assert on output markers, not exit codes.
- Empty result sets print NOTHING (not even headers) with
  `.headers on` — machine-check GUARDs with `COUNT(*)`.
- Parent inspection candidates both work: `SELECT message FROM
  dolt_log('ma^2');` walks the second parent's history (shows 'dogs');
  `SELECT message FROM dolt_log('mb..ma');` shows merge+'cats' only.

Keystone assertions (all verified in the log):
- live `state.content` = `DRIVER-DECIDED` ✓
- `SELECT content FROM dolt_at_state(dolt_hashof('ma')) WHERE
  type='m.room.topic';` = `DRIVER-DECIDED` ✓
- 2-parent reachability: `dolt_log` on ma contains BOTH 'cats' and
  'dogs' ✓ (merge commit `470ee9fbb04cd67b5a335047788751890b107d6a`
  == `dolt_hashof('ma')`)

Raw results block (final run): `/tmp/lite-spikes/ls3.log` (full
transcript; key lines quoted above).

## LS4 — branch-first ingest (D8 pattern)

Status: PASS

Discovered syntax:
- `SELECT dolt_branch('xevt');` at main HEAD, reopen as
  `'<dbfile>@xevt'`, `INSERT` event row + `INSERT OR REPLACE INTO
  state` (SQLite upsert), `SELECT dolt_commit('-Am','ls4 event 1');` →
  new hash; `SELECT dolt_hashof('xevt');` == that hash.
- `SELECT dolt_hashof('main');` afterwards == pre-branch hash (prev
  pointer unmoved) ✓.
- `SELECT * FROM dolt_diff_events('HEAD~1','HEAD');` (on xevt) →
  exactly 1 row, `diff_type` = `added`; columns `to_*|from_*|diff_type`
  with `to_commit`/`from_commit` hashes.

Raw results block (final run):
```
- h0 (main) = 9c6141a4b6c49268ed32580efba9fbdd980f5fc6
- @xevt commit → 6bd03ef9639c19723d755ccb399d7276026a9755 (== hashof('xevt'))
- hashof('main') after = 9c6141a4… (unmoved)
- dolt_diff_events('HEAD~1','HEAD'): 1 row, added $ls4e1, to_commit 6bd03ef9…
```

## LS5 — time travel

Status: PASS (run against LS4's db per phase file; hashes sourced from
`/tmp/lite-spikes/ls4.env`, reads on branch xevt)

Discovered syntax:
- `SELECT * FROM dolt_at_events('<h0>');` → historical rowset (genesis
  event row only) ✓.
- `SELECT * FROM dolt_history_events;` → 3 rows (≥2); metadata columns
  `commit_hash|committer|commit_date` ✓.
- `SELECT diff_type, to_event_id FROM dolt_diff_events('<h0>','<h1>');`
  → `added|$ls4e1` (≥1 row) ✓.
- `SELECT dolt_hashof_db();` → 40-hex (`830a6bcc1edf…`) ✓.

## LS6 — dialect features (informational)

Status: PASS

- json1 round-trip: `json_extract(doc,'$.content.body')` → `hi`;
  `json_extract(...,'$.content.tags[2]')` → `c`; `json_valid` → 1;
  `json('  { "a" : 1 }  ')` → `{"a":1}` (normalizes).
- `dolt_docs` present with a default **AGENT.md** row (DoltLite
  operations guide; its documented merge-conflict flow is the
  COMMIT→dolt_commit ordering recorded in LS3).
- `last_insert_rowid()` after INSERT into the TEXT-PK `events` table →
  `0` (engine uses TEXT ids; does not rely on rowid).
- Error-line review across ls1..ls5 logs: exactly the documented LS3
  discovery lines + LS2's `-d` refusal; nothing unexpected, no retries
  needed.
- No NO-GO items for engine-lite.

## Lite L0 log

Status: COMPLETE

What was built:
- `lite/bin/doltlite` (gitignored), `lite/spikes/native/` (`run.sh` +
  `ls1_basics.sh` … `ls6_dialect.sh`), this file; `.gitignore` gained
  exactly `lite/bin/` and `lite/web/node_modules/`.

Deviations:
- LS1's `dolt_log` check greps `|ls1$` (pipe-suffixed message column)
  instead of a bare `^ls1$` line — the spike dumps `SELECT * FROM
  dolt_log;` (all columns), so the message is the last pipe field.
  Assertion semantics unchanged.
- LS3's GUARD gained an additive `SELECT COUNT(*) AS guard_n FROM
  dolt_conflicts;` line right after the phase's literal `SELECT * FROM
  dolt_conflicts;` — empty result sets print no header in this shell,
  so the count form is the machine-checkable one. Literal line kept.
- LS3 additionally exercises the `dolt_docs`-documented COMMIT→
  dolt_commit ordering on a second branch pair (mc/md) — both orderings
  recorded working (discovery item, phase asked for "whichever works";
  both do).
- LS5 reuses LS4's db and sources `/tmp/lite-spikes/ls4.env` instead of
  starting from a fresh db — explicitly per the phase file ("Using two
  hashes from LS4's db").
- Findings beyond the phase's enumeration: `dolt_config` SET is
  session-scoped (LS1 notes); CLI continues after statement errors and
  exits 1 if any errored (LS3 notes); `-D` force-delete flag exists and
  works though undocumented in the README (LS2).

Verification transcript (`bash lite/spikes/native/run.sh`, final run):
```
binary: /home/user/Projects/communico/lite/bin/doltlite (DoltLite v0.11.53 (SQLite 3.54.0, 64-bit))
scratch: /tmp/lite-spikes
SPIKE LS1: PASS
SPIKE LS2: PASS
SPIKE LS3: PASS
SPIKE LS4: PASS
SPIKE LS5: PASS
SPIKE LS6: PASS
```

## Lite L1 log

Status: COMPLETE — gate met (`check-spikes.ts` exit 0, `WASM SPIKES: 4/4 PASS`).

What was built:
- `lite/web/package.json` + `node_modules/@dolthub/doltlite-wasm@0.11.53`
  (npm install; node_modules gitignored per plan).
- `lite/web/spikes.html` + `lite/web/spikes.js` — WASM ports of
  LS1/LS3/LS4/LS5 (WS1/WS3/WS4/WS5), same SQL and assertions, minus
  dot-commands.
- `lite/web/serve.ts` — tiny Deno static server (deviation, sanctioned by
  phase-l1 step 2): adds `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` so the OPFS question could be
  answered at all; correct MIME for `.mjs`/`.wasm`.
- `lite/web/check-spikes.ts` — jsr:@astral/astral headless-Chrome check
  (starts serve.ts itself if :8787 is free; waits ≤30 s for the final
  `#results` line; asserts `4/4 PASS`; prints the full transcript).

WASM API surface (verified, capture-don't-guess):
- `import sqlite3InitModule from
  './node_modules/@dolthub/doltlite-wasm/sqlite3.mjs'` (the package's
  plain-ESM no-bundler entry) → `await sqlite3InitModule()` → `sqlite3`
  namespace with `oo1` (`DB`, `selectValue`, `selectObjects`, `exec`).
  Loads unbundled; **no esbuild needed**.
- `dolt_version()` in WASM: `v0.11.53` — parity with the CLI.
- All spike SQL (LS1/LS3/LS4/LS5 forms) works verbatim through oo1,
  INCLUDING the full LS3 keystone: same autocommit negative-control message,
  same held-conflict explicit-transaction model, same in-txn `dolt_commit`
  semantics (trailing COMMIT errors `cannot commit - no transaction is
  active`), `dolt_conflicts`/`dolt_conflicts_state` (identical columns),
  `dolt_conflicts_resolve('--ours',...)`, GUARD, `dolt_at_state(
  dolt_hashof('ma'))`, 2-parent dolt_log reachability. Merge commit
  `86cde81d…` (final run).
- Per-connection `dolt_config` holds in WASM (committer column = 'POC'
  after one config call on the connection) — consistent with the L0
  session-scoping finding; engine sets it once per connection.
- Branch switching: spikes use `SELECT dolt_checkout('<b>')` on the single
  connection (sanctioned substitute, phase-l1 step 3). The CLI's
  `'<file>@<branch>'` open DOES exist in WASM (`active_branch()` returns
  the branch) **but is poisonous**: the next `dolt_commit` on ANY
  connection/file then fails once with
  `SQLITE_ERROR: sqlite3 result code 1: commit conflict: another connection
  committed to this branch. Please retry your transaction.` — one-shot, the
  following commit succeeds. Isolated by bisection (branch-create+close
  alone: no effect; `@`-open without close: poison; after the poisoned
  commit: clean). Same error when a second handle to the SAME file commits
  after the first handle (classic per-connection tip snapshot). Engine
  rule: ONE long-lived connection per room DB; no `@`-reopens.
- `dolt_log` default row order is newest-first; `ORDER BY date DESC,
  rowid DESC` is NOT a valid substitute (1-second date resolution +
  virtual-table rowids are meaningless — mis-orders equal-time commits).
  Use default order.

Browser-only answers:
- **PERSIST: no** (in the tested environment). The README's
  `sqlite3.oo1.OpfsDb` is the `'opfs'` VFS — worker-thread-only (requires
  `Atomics.wait`; its own feature check refuses the main thread), so
  `'opfs' in sqlite3` is `false` for a main-thread page even with
  cross-origin isolation. The build also ships `opfs-sahpool`
  (main-thread-capable), but `sqlite3.installOpfsSAHPoolVfs()` fails with
  `Missing required OPFS APIs.` — the environment probe shows
  `FileSystemFileHandle.prototype.createSyncAccessHandle` is absent on the
  main thread of astral's pinned Chrome 125 (`crossOriginIsolated: true`,
  `SharedArrayBuffer: true`, `storage.getDirectory: true` — only
  `createSyncAccessHandle` missing). Not exercised: the
  `sqlite3-worker1-promiser` entry (worker might have
  `createSyncAccessHandle` where the main thread lacks it) — it is a
  different, postMessage-shaped API and out of the oo1 pattern the POC
  uses. Consequence per plan Q2: **L2 treats the room as session-scoped and
  says so in the UI.**
- **PERF: 100 sequential event-commits in 394–423 ms** (~4 ms/commit,
  in-memory, including `dolt_commit` each).

Deviations:
- serve.ts replaces the std file-server (COOP/COEP — sanctioned).
- The `@`-branch-open probe runs after the spikes in spikes.js and carries
  its own sacrificial-commit side-effect demonstration (the poison would
  otherwise fail WS1 — discovered the hard way, bisected with a temporary
  probe page, since removed).
- `lite/web/deno.lock` was auto-created by `deno run -A check-spikes.ts`;
  kept (inside `lite/`).
- npm printed: `Warning: config file …/lite/web/package.json is not a
  member of the workspace at file:///home/user/Projects/communico/` —
  cosmetic (deno noticing the repo root deno.json); no action.

Verification transcript (`deno run -A lite/web/check-spikes.ts`, final
run, exit 0):
```
INFO init: sqlite3InitModule() from ./node_modules/@dolthub/doltlite-wasm/sqlite3.mjs → sqlite3 namespace, oo1 API present: true
INFO dolt_version (wasm): v0.11.53
INFO crossOriginIsolated: true
INFO 'opfs' in sqlite3: false (worker-thread VFS; cannot install on main thread per its feature check)
INFO persistence: installOpfsSAHPoolVfs() FAILED: Missing required OPFS APIs.
PERSIST: no (no persistent VFS: 'opfs' in sqlite3=false [worker-only], opfs-sahpool install failed, crossOriginIsolated=true)
WS1: PASS (commit eb5db20e794bfe84bc857dc5e70ccb1fa173441e, version v0.11.53, json ok; committer='POC' — per-connection dolt_config held)
INFO ws3 negative control verbatim: SQLITE_ERROR: sqlite3 result code 1: cannot merge: conflicts detected, autocommit transaction rolled back. Run the merge inside BEGIN/COMMIT to inspect dolt_conflicts and dolt_schema_conflicts, resolve with dolt_conflicts_resolve(), then commit with dolt_commit(). Conflicts are never committed as conflicts
INFO ws3 merge error-line: SQLITE_ERROR: sqlite3 result code 1: Merge has 1 conflict(s). Resolve and then commit with dolt_commit.; dolt_conflicts_state columns: from_root_ish|base_type|base_state_key|base_event_id|base_content|our_type|our_state_key|our_event_id|our_content|our_diff_type|their_type|their_state_key|their_event_id|their_content|their_diff_type|dolt_conflict_id
INFO ws3 txn ordering: dolt_commit inside txn → 86cde81d053a74fe7756e13eb0e9719350f722d5; trailing COMMIT → SQLITE_ERROR: sqlite3 result code 1: cannot commit - no transaction is active
WS3: PASS (merge 86cde81d053a74fe7756e13eb0e9719350f722d5; live+at_state=DRIVER-DECIDED; dolt_log has cats+dogs)
WS4: PASS (branch-first commit e5b0e05c7b220e7b65afde8c982caeb049dd95ad; main unmoved d4aa70e3a9fd55821aa8ca16086c4d4d5a51b783; dolt_diff_events(HEAD~1,HEAD)=1 added row)
WS5: PASS (at_events=1 row; history_events=3 rows; diff(h0,h1)=1 row; hashof_db=c841a3c04e09cdc2f668312ecaa2e74a11c74881)
PERF: 100 commits in 423 ms (in-memory; committer column on same connection = 'POC')
INFO wasm branch-open: '<db>@<branch>' filename works → active_branch()='b1'. SIDE EFFECT: next dolt_commit (any file) failed once: SQLITE_ERROR: sqlite3 result code 1: commit conflict: another connection committed to this branch. Please retry your transaction.; following commit succeeded (one-shot)
WASM SPIKES: 4/4 PASS
CHECK: PASS
```

## Lite L2 log

Status: COMPLETE — `check-poc.ts` exit 0 (all three phase assertions green).

What was built:
- `lite/web/engine-lite.js` (~190 lines, ES module, no build step) over the
  L1-recorded oo1 API: `createRoom(displayName)`, `ingestEvent(evt)`,
  `timeline()`, `doltLog(limit=10)`, `rawQuery(sql)`. Real invariants:
  D1 (>2 prev_events → `M_TOO_MANY_PREV_EVENTS`), D8 branch-first
  (`dolt_checkout(base)` → `dolt_checkout('-b','xN')` BEFORE any merge or
  write), commit-per-event, wire event id = `'$'+commit_hash` with an
  in-memory `eventIndex`/`byProvisional` map pair, 2-prev merge via the
  LS3-recorded explicit-transaction driver sequence (BEGIN → merge
  (conflict error-line tolerated, state held) → `dolt_conflicts` inspection
  (`events` conflict throws `E_EVENTS_CONFLICT`) → resolve `--ours` →
  latest-wins driver UPDATE by `(origin_ts, event_id)` (D4) → GUARD
  `COUNT(*)=0` → `dolt_commit` INSIDE the txn; trailing COMMIT's
  `no transaction is active` swallowed per the L0/WS3-recorded semantics),
  consumed prev branches deleted with `dolt_branch('-D',…)` (LS2 finding).
  Genesis path: `m.room.create` (state_key '') then creator's
  `m.room.member` join (state_key = self), chained by wire id.
  `rawQuery` is read-only (SELECT/PRAGMA guard).
- `lite/web/index.html` + `app.js` — no framework, plain CSS flex layout;
  explainer header ("version-controlled database running entirely in YOUR
  browser… every message is a commit; the event id IS the commit hash") +
  session-scoped notice shown when no persistent VFS was found (it was
  not); nominal sign-in (name → `@<name>:browser` as committer); chat pane
  (timeline newest-first, each row shows body + its `$<hash>` event id);
  live `dolt_log` pane (full hash + message per commit line, refreshed
  after every send); SQL console prefilled with `SELECT * FROM dolt_log;`.
- `lite/web/check-poc.ts` — headless astral check (starts serve.ts itself
  if :8787 is free): signs in as `poc-tester`, sends `first poc message` /
  `second poc message`, asserts the three phase criteria.

Deviations / discoveries:
- astral's `page.evaluate(fn, …)` takes options `{ args: [...] }`, NOT
  variadic args — a variadic call silently invokes the fn with NO
  arguments (my first check-poc run set `input.value = undefined`, which
  coerces to the string "undefined": sends "worked" but bodies were wrong).
  Recorded for future headless checks.
- Assertion-2 interpretation: the log pane renders each commit line with
  the FULL 40-hex hash in its textContent, so "the timeline row's
  `$<hash>` id appears in the log pane's commit lines" is a literal
  substring check (after stripping the `$`). All four rows (create, member,
  both messages) verified — not just the two new ones.
- Commit messages follow the server engine's Mode-B convention verbatim:
  `event $<provisionalId> type <type>` (the wire id can't be embedded —
  it IS the commit hash and doesn't exist until after the commit).
- SQL console smoke-checked headlessly (beyond the phase's check): default
  query renders the `dolt_log` table; `DROP TABLE events` →
  `error: read-only: only SELECT/PRAGMA allowed in this console`; empty
  result renders headers + `(0 rows)` (oo1 `exec({columnNames})` works).
- engine-lite detects persistence at runtime (tries
  `installOpfsSAHPoolVfs`, falls back to MEMFS) — in the tested
  environment it is always memory → the session-scoped notice always shows
  here.
- No 2-prev merge arises in the single-user UI flow (each send consumes
  all current extremities → linear history); the driver path is the
  WS3-proven sequence and runs when a caller passes 2 prevs.
- esbuild NOT used (wasm package loads unbundled) — recorded per plan.

Verification transcript (`deno run -A lite/web/check-poc.ts`, final run,
exit 0):
```
signed in as: @poc-tester:browser
log pane m.room.message commit lines at baseline: 0
timeline contains 'first poc message': true
timeline contains 'second poc message': true
timeline rows (event ids): ["$d7ea29199080b6cc6a3e1deaf6644986b6bc8457","$e7f5e323bd7887f1d49060230edb37a1ad073f03","$59ebfcb3af8e4d55d417544a29733a95cfc62612","$efaec2a7f27b9b8995fb10a57bb01644275b8739"]
all timeline event ids present in log pane: true
log pane m.room.message commit lines after sends: 2 (delta 2)
CHECK: PASS
```

## Blockers

### PB1 — lite-p2p-sync start gate failed: L0–L2 work uncommitted on `spike/communico-lite`

**Exact instruction** (lite-p2p-sync execution README, hard rule 3):
`git log --oneline -5` on `spike/communico-lite` must contain the L0–L2
lite commits ("POC page" / "WASM browser spikes" / "native capability
spikes" feat commits); if the `lite/` work is still uncommitted →
STOP-AND-REPORT, do not proceed on an uncommitted base.

**Observed (2026-08-24, verbatim):**
```
$ git log --oneline -8
4f1664b chore: Bidirectional demo — dual stores, warm-up sync, 140x40 recording
10ca3b8 fix: /sync must always emit rooms.join for nio self.rooms cache
0e5c52f feat: Add demo script, inspection tour, and capture notes
078bde9 feat: Add minimal /sync for real-client listen
c74e2d1 feat: Add login, versions, and client-compat auth
fb82cfe test: Add ingest bench and >2-prev rejection probe
9e0318c feat: Add two-mode Dolt room engine (rooms as repos, events as commits)
8c70a6e feat: Add Doltgres capability spikes

$ git status --short
 M .gitignore
?? lite/
```

None of the three L0–L2 feat commits exists on the branch; the previous
plan's deliverables (`lite/`, `.gitignore` lines) are entirely
uncommitted working-tree state. Per the rule, LP was NOT started. This
PB entry is the only change made after the gate check.

**What I tried:** none beyond the gate check itself — the rule is
explicit and lists no fallback.

**Resolution needed (user/validator):** land the post-validation commits
per communico-lite plan.md §4 (`feat: Add DoltLite native capability
spikes (L0)`, `feat: Add DoltLite WASM browser spikes (L1)`,
`feat: Add in-browser room POC page (L2)`), then re-dispatch
lite-p2p-sync. NOTE: this PB entry is itself an uncommitted edit to
`lite/RESULTS.md`; it should ride the L1/L2-era commit that carries
`lite/RESULTS.md` (L2's commit) or be committed at the validator's
discretion.

**RESOLVED 2026-08-24 by validator (decision A, per the executor/validator
split):** validation reruns all green (`run.sh` 6/6, `check-spikes` 4/4,
`check-poc` PASS; lint clean; a DOM-lib typecheck directive added to
`check-poc.ts`). The three plan-§4 commits land now, verified green per
commit; lite-p2p-sync re-dispatch follows. This RESULTS.md (including this
entry) rides the L0 commit as the capability/log document.
