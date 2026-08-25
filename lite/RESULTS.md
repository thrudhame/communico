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

## P2P LP log

Status: **BLOCKED — plan paused at plan-level option C** (upstream bundle:
PB2 + PB3 + PB4, all in `## Blockers`). LP gate per the P-D2 revision
(`LP SPIKES: 3/3 PASS` + `LP2C: 10/10 GENERATIONS CLEAN` + LP3 hash
equality) cannot pass on @dolthub/doltlite-wasm 0.11.53: LP1 PASS,
LP2a PASS, LP3 PASS, **LP2C hangs** (PB4). L4 never started.

What was built (all uncommitted per rule 2):
- `lite/web/lp-spikes.html` + `lp-spikes.js` — LP1, LP2a (positive path),
  LP2c, LP3 (role pages `?role=a|b`); the live reproduction of all three
  PB-class findings.
- `lite/web/sync/transport.js` — transport interface
  (`createTransport(kind)` → `{join(room,{onPeer,onMessage}) → {send(obj,
  bytes?), peers(), leave()}}`) + BroadcastChannel adapter (channel
  `communico-lite:<room>`, hello/hello-ack/bye peer discovery, ArrayBuffer
  via structured clone, own-echo suppression). Verified by LP3.
- `lite/web/check-lp.ts` — 3-page astral check enforcing the revised gate.

Discovered/verified API forms (verbatim — the capture-don't-guess record):
- **Export store**: `sqlite3.capi.sqlite3_js_db_export(db.pointer)` →
  `Uint8Array` (full store incl. commit graph + refs — equality verified).
- **Import form 1 (read-only probes only!)**:
  `sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', ptr, len, len, 3)`
  with `ptr = sqlite3.wasm.allocFromTypedArray(bytes)` — rc 0, content
  equal — **but a deserialize'd handle can NEVER be re-exported**
  (`sqlite3_serialize` → `SQLITE_ERROR`, all flag variants 3/2/1/0; PB3).
- **Import form 2 (the live-replica route)**:
  `sqlite3.capi.sqlite3_js_vfs_create_file('unix', path, bytes)` +
  `new oo1.DB(path)` — content equal, re-exportable, survives commits and
  adoption chains (until the PB3/PB4 lineage hang). Deprecation warning is
  cosmetic. MEMFS has NO subdirectories (no `FS`/`Module` handle exposed;
  `SQLITE_CANTOPEN` on `/sub/dir` paths — root-level files only).
- **`dolt_hashof_db()` = pure function of (ref set + HEAD)**. HEAD does
  NOT survive an image (imported handle opens on `main`); convention:
  `dolt_checkout(<tip branch>)` on the receiver before comparing.
- **Commit-poison trigger map** (browser, file-backed subject): the
  one-shot `commit conflict: another connection committed to this branch`
  fires on the next commit ANYWHERE after (a) `sqlite3_deserialize` onto a
  handle, or (b) `oo1.DB` open of an existing store image. NOT triggered
  by: fresh-empty handle open, other handles' commits, checkouts, plain
  `vfs_create_file`, exports. The failed commit leaves working state
  INTACT → robust form = retry the `dolt_commit` statement ONLY, once
  (never re-run the INSERT — it persists; a re-run violates PK).
- Remotes in WASM (PB2 matrix): `dolt_remote('add',...)` persists the row
  (noisy `SQL logic error` on `:memory:` receivers); `dolt_fetch/pull/
  clone` crash at the wasm ABI level (`null function or function
  signature mismatch` / `table index is out of bounds`). Native v0.11.53
  CLI: same SQL works; fetched refs land as `refs/remotes/<remote>/*`,
  reachable via `dolt_log('peerA/main')` and `dolt_hashof('peerA/main')`.
- `VACUUM INTO` → `VACUUM INTO is not supported for doltlite databases`.
- `dolt_branch('-D','main')` → `cannot delete the default branch; call
  dolt_default_branch(<other>) first`.
- `dolt%` function inventory (34 names, WASM build): `dolt_add
  dolt_branch dolt_checkout dolt_cherry_pick dolt_clone dolt_commit
  dolt_config dolt_conflicts_resolve dolt_connect_branch dolt_creds
  dolt_creds_new dolt_default_branch dolt_fetch dolt_gc dolt_hashof
  dolt_hashof_catalog dolt_hashof_db dolt_hashof_table dolt_merge
  dolt_merge_base dolt_pull dolt_push dolt_rebase dolt_remote dolt_reset
  dolt_revert dolt_tag dolt_verify_constraints dolt_version
  doltlite_engine doltlite_internal_materialize_default_column`.
- astral harness lessons: `page.evaluate(fn, {args:[...]})` (NOT
  variadic); polls against a main-thread-blocked page fail with
  RetryError (poll in try/catch and keep waiting); serve test servers
  with `Cache-Control: no-store` (serve.ts updated) — without it Chrome
  heuristically served a STALE module mid-bisection (false "hang"
  readings until busted).

LP2a/LP2c spike-local notes: minimal inline branch-first ingest (phase
permitted engine-lite reuse OR inline SQL — inlined; engine-lite wiring
was an L4 deliverable that never gated in).

Deviations:
- LP2a's spike drops the fork negative-control (P-D2: it
  deterministically hangs this build — PB3; superseded by LP2c's control
  at generation ~6 on the recycled architecture, which itself hangs
  earlier — PB4).
- LP2c's 15 s-per-ingest watchdog is enforced at the check level
  (check-lp timeout) + per-generation progress lines: a wasm hang never
  yields to the JS event loop, so no in-page timer can fire
  mid-statement (recorded).
- check-lp staggers page creation 500 ms (triple simultaneous wasm
  compiles contend on the loaded host).

Gate transcript (final state, `deno run -A lite/web/check-lp.ts`, exit 1
— the LP2C hang IS the gate state):
```
---- page1 #results ----
INFO dolt% functions (34): …(full list in PB2)…
INFO export: capi.sqlite3_js_db_export(db.pointer) → Uint8Array 10715 bytes
INFO import form 1: capi.sqlite3_deserialize(…) → hashof_db 8f18cbed… (equal: true); active_branch()='main'
INFO import form 2: sqlite3_js_vfs_create_file(…) + open → hashof_db 8f18cbed… (equal: true)
LP1: PASS (hashof_db A=8f18cbedd3c7bcb3c0ba4aacb97ac44ada2ff573 B=8f18cbedd3c7bcb3c0ba4aacb97ac44ada2ff573 EQUAL (both import forms); dolt_log messages + dolt_branches [main,x1] equal; unmerged x1 survived)
INFO lp2a: bootstrap-clone: hash equality (B on tip branch x2) = true
INFO lp2a: probe#1: peer tip branch x3, contains B tip = true
INFO lp2a: after adopt#1: B sees from-alice=true; hashof_db(B)==hashof_db(A): true
INFO lp2a: probe#2: contains A tip = true
INFO lp2a: after adopt#2: A sees from-bob=true; re-export of adopted+committed store OK (18416 bytes)
LP2b: BLOCKED-UPSTREAM (PB2) — dolt_fetch/pull/clone crash at wasm ABI level in @dolthub/doltlite-wasm 0.11.53; …
LP2a: PASS (linear convergence via superset adoption + handle recycling; final dolt_hashof_db A=5ed8bdabf9a8bde7b43c3a9255147b1b1ff841bb B=5ed8bdabf9a8bde7b43c3a9255147b1b1ff841bb EQUAL)
LP2C-GEN 1: ok (47 ms; gen-1-c adopted by d; hash 8072fe27)   ← page hangs here (PB4)
---- LP3 role pages ----
LP3-HASH-A: bd4ee9b2b72a265a74f3ed5976b510a06821e42fd158b7afd8b21e709ae74c8b
LP3-HASH-B: bd4ee9b2b72a265a74f3ed5976b510a06821e42fd158b7afd8b21e709ae74c8b
LP SPIKES 3/3: false; LP2C 10/10: false
LP3 cross-page hash equality: true
CHECK: FAIL (exit 1)
```

## W0 log

Status: IN PROGRESS (W0a COMPLETE).

### W0a — build the amalgamation-lineage artifact (COMPLETE)

- Toolchain: emsdk user-local at `~/tools/emsdk`; emcc 6.0.8
  (aeb67926e7de656da38bc807d83050af93578758), sdk release
  `9d70dbe8860ccdd3595f6e6065d94bfb543ae955`.
- Inputs: `doltlite-amalgamation-0.11.54.zip` sha256
  `bd0bf68e6b2ebb389af5cb0cce80b0a71e3051043ac091ab0f0ab2f7c6dc5f2a`
  (contains `doltlite.c` = SQLite 3.54.0 amalgamation + doltlite,
  `doltlite.h`, `doltliteext.h`); doltlite clone @ v0.11.54
  (b8f9f72c9b43d9d1e75e3bc51f0380d3f41f56ba); wa-sqlite clone (harness).
- **Recipe route: R2 (wa-sqlite harness)**, because R1's in-tree search
  found only: `make -C ext/wasm [dist|npm]` (the broken npm lineage (b)
  — PB2) and `test/amalgamation_wasm_compile_test.sh` (a compile-only
  smoke test; its link step exports just `_sqlite3_initialize`, not the
  full C API the wa-sqlite JS needs). R1 therefore had no usable recipe;
  the compile-flag SET inside that test script is what PR #2165
  validated, and its defines were carried into the R2 build.
- Build details + exact commands: `lite/web/w0/BUILD.md`. Headline: stock
  wa-sqlite `make dist` flow with `deps/version-3.53.0/sqlite3.c|.h`
  replaced by the DoltLite amalgamation, `CFILES` without
  `extension-functions.c` (kept offline), a no-op
  `RegisterExtensionFunctions` stub added (wa-sqlite's `open_v2` calls it
  unconditionally), defines `-DSQLITE_WASM -DDOLTLITE_PROLLY=1
  -DDOLTLITE_VEC1=0 -DVEC1_THREADS=0 -DDOLTLITE_VERSION=\"v0.11.54\"`
  (wa-sqlite defaults already supply `-DSQLITE_THREADSAFE=0`;
  `DOLTLITE_ENABLE_REMOTES` left at its default 1).
- **Deviation recorded (flag list):** the plan's PR-#2165 flag
  `SQLITE_OS_OTHER=1` does not link in this harness
  (`wasm-ld: undefined symbol: sqlite3_os_init` — with OS_OTHER the
  app must supply os_init/os_end; wa-sqlite supplies neither). Dropped;
  wa-sqlite's default `SQLITE_OS_UNIX` (emscripten MEMFS) is used.
  (`-DSQLITE_OS_KV=1` → kvvfs os_init was the alternative; not needed.)
- Acceptance: node — `dolt_version()` = `v0.11.54`, 34 `dolt%` fns incl.
  the remote five; browser (astral, bare page) — same + a commit visible
  in `dolt_log`. Artifact: `lite/web/w0/vendor/doltlite.mjs` (138 951 B)
  + `doltlite.wasm` (1 416 622 B).
- wa-sqlite JS API surface (recorded): NOT oo1 —
  `SQLiteESMFactory()` → `_sqlite3_initialize()` →
  `SQLite.Factory(module)` → `await sqlite3.open_v2('name.db')` →
  `await sqlite3.exec(db, sql, (row, columns) => …)`. `wa-sqlite@1.0.0`
  npm (W0b step 1 done early for the probe).
- Note: the artifact's remote HTTP client is raw POSIX sockets + mbedtls
  TLS (`src/doltlite_net.h`, `src/doltlite_tls.c`,
  `src/doltlite_http_remote.c`) — in node these are real sockets
  (emscripten node env); in a browser, emscripten maps `connect()` over
  WebSocket to a configured bridge URL, so a raw-TCP relay needs a ws↔tcp
  bridge or the sanctioned same-origin proxy story in W0c.

### W0b — clone-from-DoltHub in our context (DONE — gate FAILED both runtimes; see WB1)

- `wa-sqlite@1.0.0` installed into `lite/web/package.json` (recorded;
  additionally `ws` installed with `--no-save` during probing — node_modules
  only, package.json/lock untouched per rule 3; recorded here).
- Pages/scripts: `lite/web/w0/clone-test.html|js` (browser),
  `w0/clone-test-node.mjs` (node), plus `w0/w0a-pagetest.html` (W0a browser
  acceptance).
- **Browser (verbatim):**
  ```
  module up; cloning https://dolthub.com/dolthub/remote-prod-test …
  W0B: FAIL could not connect to remote
  ```
  Root cause (code-level): the artifact's remote HTTP client is raw POSIX
  TCP + mbedtls TLS; under emscripten in a browser, `connect()` is wrapped
  as a WebSocket dial to the target host:port (`ws(s)://dolthub.com:443/…`)
  — dolthub.com serves no ws endpoint, so the dial fails. NOT a CORS issue
  (no fetch/XHR ever happens; the transport is sockets).
- **Node (verbatim)**, two socket backends:
  - stock (WebSocket-wrap): `W0B-NODE: FAIL could not connect to remote`
    (emscripten's node path wraps TCP in the `ws` package's WebSocket
    protocol; an HTTPS port speaks neither).
  - `-s NODERAWSOCKETS=1` (real `node:net` TCP): **TCP connect SUCCEEDS**
    to the local relay (instrumented: `tcpconnect result fd=5`) but the
    HTTP exchange never completes: `read(fd=5) failed errno=6 (Resource
    temporarily unavailable)` → the C read loop (`doltliteConnRead`)
    busy-spins on WANT_READ with no yield to the JS event loop, queued
    writes never flush, deadline expires → `SQLITE_IOERR (10)` →
    `clone failed`. The ASYNCIFY variant fails IDENTICALLY (the busy loop
    has no asyncify suspension points). C-level instrumentation was done
    on a scratch amalgamation copy in /tmp (never shipped; the vendored
    artifact is the pristine-sources build — verified 0 debug strings).
- Additional recorded nails: `file://` remotes in the wasm build see only
  MEMFS (`sqlite3_open_v2('/tmp/…')` → CANTOPEN; the host FS is invisible),
  so the "filesystem remote client" can't reach host files from node
  either; and TLS trust roots (`/etc/ssl/certs/…`) are also MEMFS-invisible,
  so even a completed TCP connect to dolthub.com would fail TLS init.
- **Verdict: the amalgamation lineage's remote client is compiled in but
  non-functional under emscripten single-threaded runtimes (browser AND
  node), on both socket backends.** Whether PR #2165 ever validated remotes
  in an actual wasm runtime is UNVERIFIED from here — the repo's in-CI wasm
  tests (`ext/wasm/test-doltlite-*.mjs`) do not touch remotes; all remote
  tests are native shell tests (`test/remotesrv_http_test.sh` etc.).
  The plausible working configuration class (NOT attempted — unlisted):
  pthreads + PROXY_TO_PTHREAD + SharedArrayBuffer build (crossOriginIsolated
  is already on), or a C-level yield in the WANT_READ loop (doltlite source
  change = upstream fix track).
- Gate evaluation: `W0B: PASS` (browser) NOT met; `W0B-NODE: PASS` NOT met
  → **W0b gate FAILED → STOP-AND-REPORT (WB1)**. W0c's native smoke had
  already been run as sanity (below) and PASSES; the cross-tab wasm pages
  are moot (no remote op completes in wasm) and were not built.

### W0c — localhost relay, cross-tab (PARTIAL — native smoke only; see WB1)

- Relay binary: `doltlite-remotesrv` from
  `doltlite-tools-linux-x64-0.11.54.zip` → `lite/bin/doltlite-remotesrv`
  (gitignored). ALSO per phase: `lite/bin/doltlite` replaced 0.11.53 →
  **0.11.54** from the same zip (keeps CLI and wasm pinned; recorded).
- Relay start: `lite/bin/doltlite-remotesrv -p 8388 /tmp/w0-remotes/`
  → `doltlite-remotesrv serving /tmp/w0-remotes/ on http://127.0.0.1:8388`
  (defaults to 127.0.0.1 binding; port 8388 was free). Run it DETACHED
  (`setsid ... </dev/null >log 2>&1 &`) — a plain `nohup … &` died with the
  tool's process-group kill mid-session (recorded operational note).
- **Native relay smoke (0.11.54 CLI) — PASS**, exact working forms:
  ```
  SELECT dolt_remote('add','origin','http://127.0.0.1:8388/room.db'); -- → 0
  SELECT dolt_push('origin','main');   -- → 0 (store file appears in /tmp/w0-remotes/)
  SELECT dolt_clone('http://127.0.0.1:8388/room.db');  -- fresh db → 0; content + log arrive
  SELECT dolt_pull('origin','main');   -- → 0; new rows arrive
  ```
  Discovered: **`dolt_pull` requires BOTH args on 0.11.54** —
  `dolt_pull('origin')` → `usage: dolt_pull(remote, branch)`.
  (Same-version retest note: PB2's native behaviors hold on 0.11.54.)
  Native clone side-quirk: `dolt_clone` on a file:// URL prints
  `failed to add origin remote` AFTER fully cloning the content (rc=1 but
  data complete) — cosmetic, recorded.
- Relay protocol note (for the future fix): it is a JSON/HTTP API
  (`GET /room.db` → 404 `{"code":"not_found","sqlite":12,…}` for unknown
  remotes), NOT a WebSocket server — so emscripten's ws-wrapped TCP from a
  browser cannot reach it even before CORS (CORS probe moot — recorded as
  such; the sanctioned `/relay/*` HTTP proxy wouldn't help a raw-TCP
  client, which is why it wasn't added).

### W0d — THE DECISIVE MEASUREMENTS (NOT RUN — moot, see WB1)

W0d measures "stores growing in place via dolt_fetch/dolt_pull" in the
browser. Since no remote operation completes in the wasm build (WB1),
the measurements cannot run. The decisive question — "does the PB4 lineage
hang exist on the designed fetch path?" — is **UNANSWERED**: the designed
fetch path doesn't exist in this build. Not a hang finding; an absence
finding. (If a future build fixes WB1, W0d runs as written.)

### W0e-prep — cross-browser instructions (NOT APPLICABLE — no working page)

There is no page to hand to the human (W0c's relay-test page was never
written — its browser transport is dead per WB1). When a fixed artifact
exists, the intended instructions would have been: start the relay
(`lite/bin/doltlite-remotesrv -p 8388 /tmp/w0-remotes/`) + serve
(`deno run --allow-net --allow-read lite/web/serve.ts`), open the
relay-test page with `?role=a` in Chrome and `?role=b` in Firefox, watch
timelines converge, copy back the two `dolt_hashof_db()` lines. Firefox
COOP/COEP note: our serve.ts already sends the isolation headers; the
sync build needs no SharedArrayBuffer anyway (no threads) — nothing
observed (never ran).

## Blockers

### MB1 — matrix-sync start gate failed: tree dirty (LP/W0 backlog uncommitted) (STOP-AND-REPORT)

**Exact instruction** (matrix-sync execution README, hard rule 3):
`git status --short` must show a clean tree on `spike/communico-lite`
(the LP/W0 backlog committed by the validator before dispatch). Dirty
tree → STOP-AND-REPORT.

**Observed (2026-08-24, verbatim):**
```
$ git status --short
 M lite/RESULTS.md
 M lite/web/deno.lock
 M lite/web/package-lock.json
 M lite/web/package.json
 M lite/web/serve.ts
?? lite/web/check-lp.ts
?? lite/web/lp-spikes.html
?? lite/web/lp-spikes.js
?? lite/web/sync/
?? lite/web/w0/

$ git log --oneline -3
96df13e feat: Add in-browser room POC page (L2)
222a774 feat: Add DoltLite WASM browser spikes (L1)
7075288 feat: Add DoltLite native capability spikes (L0)
```

The lite-p2p-sync LP deliverables (transport.js, lp-spikes, check-lp,
sync/) and the wasm-remotes-w0 deliverables (w0/, RESULTS.md W0 log +
WB1, package.json/locks wa-sqlite, serve.ts no-store) are all present
but uncommitted; HEAD is still the L2 commit. Per the rule, MS0 was NOT
started. This MB entry is the only change made after the gate check
(same pattern as PB1).

**What I tried:** none beyond the gate check itself — the rule is
explicit and lists no fallback.

**Resolution needed (validator):** land the backlog per the two plans'
commit strategies — lite-p2p-sync §4 (`feat: Add P2P sync spikes —
serialize, file-remote convergence, transport (LP1-3)` — noting the LP
gate state is recorded-failing at LP2C by design, the spikes/findings
being the value) and wasm-remotes-w0 §4 (`feat: Add W0 success-path
spikes — amalgamation-lineage WASM remotes` — explicitly lands even with
W0d unrun, per its §4 note). Then re-dispatch matrix-sync. This MB1
entry rides whichever commit carries `lite/RESULTS.md`.

### WB1 — wasm-remotes-w0: the amalgamation-lineage wasm remote client cannot complete an HTTP round trip (STOP-AND-REPORT)

**Exact instruction** (phase-w0 W0b): port `examples/wa-sqlite-clone.mjs`
against the W0a-vendored artifact — `dolt_clone('https://dolthub.com/
dolthub/remote-prod-test')` then `dolt_log`; if the browser fails with a
network/CORS-shaped error, run the same logic under deno/node
(`W0B-NODE`) to prove the client works.

**Result: BOTH runtimes fail; the gate (`W0B: PASS` OR `W0B-NODE: PASS`
+ browser finding) is unmet.** Full evidence in `## W0 log` (W0b section);
essentials:

- Browser (headless Chrome, page `lite/web/w0/clone-test.html`):
  `W0B: FAIL could not connect to remote`. The remote client is raw POSIX
  sockets + mbedtls TLS; emscripten wraps browser `connect()` as a
  WebSocket dial to `wss://dolthub.com:443/…` (no such ws endpoint).
- Node (ws-package WebSocket backend): same failure — ws protocol to a
  plain HTTPS port.
- Node (`-s NODERAWSOCKETS=1` build, real `node:net`): instrumented C
  run — TCP connect succeeds (`tcpconnect result fd=5`), then
  `read(fd=5) failed errno=6 (Resource temporarily unavailable)` → the
  C read loop busy-spins on WANT_READ without yielding to the JS event
  loop (queued writes never flush; server logs show zero bytes received)
  → `SQLITE_IOERR(10)` → `clone failed`. Asyncify variant: identical
  (the loop has no suspension points).
- Corollary gaps: `file://` remotes see only MEMFS (host FS invisible);
  TLS trust roots unreadable from MEMFS.

**What I tried (in order):** stock-sockets browser build; node with
`ws` present (`--no-save`, node_modules-only, package.json untouched per
rule 3); NODERAWSOCKETS build (node:net); ASYNCIFY variant build; a
DEBUG (assertions) build; C-level instrumentation of a scratch
amalgamation copy (entry/connect/read fprintfs — the evidence above);
file:// remote against MEMFS (CANTOPEN) and host FS (invisible).
**Not tried (unlisted):** pthreads+PROXY_TO_PTHREAD+SAB build;
websockify-style ws→tcp bridge (also wouldn't fix the read loop);
patching doltlite's read loop to yield (upstream source change);
handing W0c/W0d a node-process "tabs" substitution (would be an
unlisted workaround — W0d's measurements belong to the browser fetch
path by design).

**Decision needed:** the plan's premise — "remotes already wired on the
amalgamation lineage" — is only half true: the client is COMPILED IN
(and PB2's npm-lineage ABI crash is absent here), but no wasm runtime
can complete a remote round trip with it. Candidate directions for the
author: (a) the pthreads/PROXY_TO_PTHREAD build attempt (new spike,
browser-feasible in principle — crossOriginIsolated already on); (b)
upstream: "amalgamation-lineage remote client deadlocks/emulates-poorly
under emscripten single-threaded runtimes" bundles naturally with the
PB2+PB3+PB4 report set; (c) rethink whether L4's sync path should use
remotes at all vs the LP2a-style byte-shipping (which PB4 hangs
blocked). NOTE the interaction: PB4 hangs the byte-shipping path; WB1
blocks the remotes path — the two browser sync roads are both currently
closed, only at different mile markers.

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

### PB4 — LP2c outcome: handle-recycling does NOT fix the lineage hang → plan-level option C (upstream bundle + pause)

**Status: outcome reached per P-D2's pre-decided branch.** The LP2c
longevity probe (10 alternating generations, full recycling discipline:
adopt = close old handle + write bytes to a fresh MEMFS file + open FRESH
handle + tip checkout; retry-once on the next commit) **HANGS at
generation ~2–3**, nondeterministic exact point:

```
LP2C-GEN 1: ok (117 ms; gen-1-c adopted by d; hash 8072fe27)   ← then dead
```
```
LP2C-GEN 1: ok … LP2C-GEN 2: ok (71 ms; gen-2-d adopted by c; …)  ← then dead
```

The hang is NOT in the probe/adopt/export steps (sub-step instrumentation
shows `ingest done → export ok → probe superset=true → recycle done →
hashes read` all completing) — it strikes inside a later generation's
commit path, varying run to run, in browser AND node entry alike.
Chrome's stderr shows NO renderer crash (it's a wasm-layer hang, not a
crash). Handle-state recycling (P-D2's hypothesis) therefore does NOT
cover it — the corruption appears to accumulate at MODULE/store-identity
level across the adopt→commit→export→adopt chain, not per-handle.

**Per P-D2, this outcome = plan-level option C, already decided: bundle
PB2+PB3+PB4 for upstream, pause the plan; no further fighting (option
B's open-ended debugging was rejected).** L4 not started (LP gate
unreachable: LP2C can never print `10/10 GENERATIONS CLEAN` on 0.11.53).

**Deliverable state at stop:** `lite/web/lp-spikes.html|js` IS the live
reproduction (LP1 PASS, LP2a PASS, LP2b blocked-upstream note, LP2C
hangs; LP3 verified separately). `check-lp.ts` enforces the revised gate
(`LP SPIKES: 3/3 PASS` + `LP2C: 10/10 GENERATIONS CLEAN` + LP3
cross-page hash equality) — currently fails at the LP2C hang, by design
(it IS the regression detector for the upstream fix). `sync/transport.js`
(BC adapter) is verified working by the LP3 spike.

**Watchdog mapping (recorded per LP2c's spec):** an in-page 15 s
per-ingest watchdog is inexpressible for this failure class — a wasm-layer
hang never yields to the JS event loop, so no JS timer can fire
mid-statement. The bound is enforced by check-lp's overall timeout plus
per-generation `LP2C-GEN <n>` lines marking the last clean step.

### PB3 — LP2a composition hangs: write-after-deep-adoption-lineage freeze in the WASM store layer (STOP-AND-REPORT #2)

**Status: RESOLVED by plan decision P-D2 (validator session
ses_fd2add951ffer9kl2Zf8K1WwZI, 2026-08-24; plan.md §9 + both phase
files updated by the decider):** "A-modified" — LP2a shrinks to the
proven positive path (bootstrap + both adoptions + hash equality); the
fork negative-control does NOT move to L4 (the hang is
lineage-depth-dependent and L4's linear chat composes the same lineage —
relocated detection would relocate the hang into the user's chat);
instead a new bounded probe **LP2c (handle recycling)** tests the
discipline "adoption always yields a fresh handle" (file route + tip
checkout + close old + retry-once commit) across 10 alternating
generations with the fork negative-control at generation ~6. 10/10 clean
→ recycling becomes a NORMATIVE L4 engine rule; any hang → plan-level
option C (bundle PB2+PB3 upstream, pause) with no further fighting.
**PB3 bundles with PB2 for the user's upstream report regardless of
outcome.**

Original record follows. LP2a's *substance* (linear
convergence via superset adoption) was demonstrated end-to-end; the full
spike then hangs deterministically at the negative-control fork ingest, in
BOTH the browser AND the node entry. Extensive bisection follows.

**What works (all verified, mostly repeatedly):**
- LP1 PASS: export via `sqlite3.capi.sqlite3_js_db_export(db.pointer)`;
  import equality (dolt_log/dolt_branches incl. unmerged branch/
  dolt_hashof_db) via BOTH `sqlite3_deserialize(ptr,len,len,3)` onto
  ':memory:' AND `sqlite3_js_vfs_create_file('unix',path,bytes)` + open.
- LP2a through BOTH adoptions (node transcript): bootstrap-clone hash
  equality ✓; A commits `from-alice`, B probes (superset=true), B adopts
  (sees `from-alice`, `hashof_db` equal) ✓; B commits `from-bob` on the
  adopted handle ✓; **B re-exports the adopted+committed store fine**
  (18416 bytes) ✓; A probes (superset=true), A adopts (sees `from-bob`,
  `hashof_db` equal) ✓. Linear convergence: ACHIEVED.
- Poison trigger map (browser probe, file-backed subject):
  `deserialize onto a handle` and `oo1.DB open of an existing store
  image` poison the next commit ANYWHERE (one-shot 'commit conflict:
  another connection committed to this branch'; the failed commit leaves
  working state intact → retry the COMMIT only, once). NOT triggers:
  fresh-empty handle open, another handle's commit, checkout, plain
  `vfs_create_file`, export.
- `dolt_hashof_db()` = pure function of (ref set + HEAD). HEAD does NOT
  survive a store image (`active_branch()` resets to 'main' on import) —
  the receiver must `dolt_checkout(<tip branch>)` before hash comparison.
- `VACUUM INTO` is NOT supported by DoltLite ("VACUUM INTO is not
  supported for doltlite databases") — closed as a re-export recovery
  route.
- Branch deletion: `dolt_branch('-D','main')` errors "cannot delete the
  default branch; call dolt_default_branch(<other>) first".

**The defect:** the spike's negative control (P-D1 step 6: fork detection)
does two more ingests on the deeply-adopted handles. The 5th-generation
ingest (`fork-alice` on the twice-adopted A handle) **hangs inside the
wasm layer at the plain `INSERT INTO events …` statement** — not a
catchable error; the statement never returns (node run: exit 124 via
timeout; browser: renderer main-thread permanently blocked, page dies to
CDP). Chrome stderr shows NO renderer crash (it's a hang, not a crash).

**Reproduction attempts to isolate (all in node entry unless noted):**
- v14 shape (file-adopt → commit → export → open → write, NO branch
  deletes): PASSES.
- Same + branch tombstones (`-b`/`-D` history): PASSES.
- Same + receiver tip-checkout + branch-first checkout(-b) before the
  write (exact forkA statement shape): PASSES.
- Full LP2a flow: hangs at the forkA insert — requires the WHOLE composed
  lineage (2 genesis commits + from-alice + adopt + from-bob + adopt +
  then the 5th-gen ingest; plus interleaved probe handles).
- Browser vs node: identical hang point class in both (the browser
  additionally presents flakier — same store layer under heavier
  contention).

**Working theory (unproven):** store-identity/shared-registry corruption in
the beta — an exported image carries a store identity; adopted copies
opened while the source handle lives are second connections on the same
identity (cf. the one-shot poison class); by the 5th generation of
adopt+commit+re-export the write path enters a bad state and loops.
Minimal repro not yet achieved (all reduced forms pass).

**What this blocks:** the LP2a spike's negative control never completes →
`LP SPIKES: 3/3 PASS` unreachable → L4 gate closed. The LP2a POSITIVE
path (superset adoption convergence, both directions, hash equality) is
proven working (node transcript above; identical code path).

**Deliverable state at stop:** `lite/web/lp-spikes.html|js` (LP1 PASS,
LP2a composed-but-hanging, LP3 PASS) + `lite/web/sync/transport.js` +
`lite/web/check-lp.ts` written; LP3 verified end-to-end (BroadcastChannel
heads→want→store round-trip, SHA-256 store bytes equal across two tabs,
multiple runs). Nothing committed (rule 2).

### PB2 — LP2 KEYSTONE: file remotes are broken in `@dolthub/doltlite-wasm` 0.11.53 (STOP-AND-REPORT)

**Exact instruction** (phase-lp.md LP2 steps 3–6): write the peer store as
a file in the WASM VFS, then on the receiving replica
`SELECT dolt_remote('add','peerA','file:///peerA.db'); SELECT
dolt_fetch('peerA');`, discover remote-ref naming, heal via the
WS3-recorded driver merge, and converge to equal `dolt_hashof_db()`.

**Result: file remotes are FUNDAMENTALLY UNAVAILABLE in the WASM build —
every operation that opens a remote crashes at the wasm ABI level. The
identical SQL works natively (same version). LP stopped here per
phase-lp.md step 7; LP1's findings (positive) are recorded below; L4 was
never started.**

**Environment:** `@dolthub/doltlite-wasm` 0.11.53, astral headless Chrome
125, page cross-origin-isolated, MEMFS (no OPFS). Contrast binary:
`lite/bin/doltlite` v0.11.53 native CLI.

**Full error matrix (verbatim, all in-browser unless noted):**

| Operation | Form tried | Result |
|---|---|---|
| `dolt_remote('add','peerA','file:///peerA.db')` | local db `:memory:` | throws `SQLITE_ERROR: sqlite3 result code 1: SQL logic error` — **but the remote row persists** in `dolt_remotes` (noise-on-success) |
| same | local db file-backed (`/b-local.db`) | `0` clean (once); `SQL logic error` on a later run — flaky; row persists either way |
| same | subdir URL `file:///peers/c.db` | `0` (but see mkdir note below) |
| `dolt_fetch('peerA')` | via `selectValue` and via `exec` | **`null function or function signature mismatch`** (emscripten ABI crash) |
| `dolt_fetch('peerA','main')` | 2-arg | **`table index is out of bounds`** (wasm table ABI crash) |
| `dolt_pull('peerA')` | 1-arg | `usage: dolt_pull(remote, branch)` (proper usage error — parser alive) |
| `dolt_pull('peerA','main')` | 2-arg | **`table index is out of bounds`** |
| `dolt_clone('file:///peerA.db')` | 1-arg, into a db with content | `database is not empty — clone into a fresh database` (proper Dolt error — arg parsing + local checks alive) |
| `dolt_clone('file:///peerA.db')` | 1-arg, into a FRESH just-opened db | **`table index is out of bounds`** |
| `dolt_fetch` on remote with URL `file:/peerB.db` | single-slash path form | `failed to open remote (URL must start with file:// or http://)` (proper rejection of the bad form — reaches URL validation) |

The pattern: SQL parsing, URL validation, remote-catalog writes, and
clone's local-target checks all work; the crash fires exactly when the
machinery would OPEN/transfer the remote store — i.e., the remote IO
vtable is unwired in the WASM build. Both ABI error flavors observed
(`null function or function signature mismatch`, `table index is out of
bounds`) are emscripten-level null/mismatched function-pointer faults,
not SQL errors.

**Listed fallbacks exhausted:**
- Path forms `file:///peerA.db` vs `file:/peerB.db`: crash vs proper
  rejection (above).
- Different VFS dir (`/peers/…`): **untestable by construction** — this
  build exposes no Emscripten `FS`/`Module` handle (`sqlite3.FS`,
  `sqlite3.Module`, `sqlite3.wasm.FS` all `undefined`), so no `mkdir`;
  `sqlite3_js_vfs_create_file('unix','/peers/c.db',…)` →
  `SQLITE_CANTOPEN` and even `new oo1.DB('/peers/x.db')` →
  `SQLITE_CANTOPEN: unable to open database file`. Root-level MEMFS
  files only. (Moot anyway: fetch crashes on root-level files too.)
- Local replica `:memory:` vs file-backed: crash either way.
- `dolt_pull` / `dolt_clone` as alternate remote paths: same ABI crash.

**Native contrast (same version, host CLI, works end-to-end):**
```sql
-- on /tmp/lite-spikes/rB.db:
SELECT dolt_remote('add','peerA','file:///tmp/lite-spikes/rA.db');  -- → 0
SELECT dolt_fetch('peerA');                                          -- → 0
SELECT * FROM dolt_remotes;   -- peerA | file:///… | fetch_specs = ["refs/heads/*:refs/remotes/peerA/*"]
SELECT message FROM dolt_log('peerA/main') LIMIT 2;   -- c2 on A | c1 on A  ✓
SELECT message FROM dolt_log('remotes/peerA/main');   -- same ✓ (both spellings resolve)
SELECT dolt_hashof('peerA/main');  -- eaa84ca6aaeab2e78bb5ea86b9ff7a9e548dbb70 ✓
```
So the remote-ref naming the plan asks about is recorded NATIVELY:
fetch materializes `refs/remotes/<remote>/*`, reachable as both
`'<remote>/<branch>'` and `'remotes/<remote>/<branch>'` in
`dolt_log`/`dolt_hashof`. None of this is reachable in WASM due to the
crash.

**LP1 findings (POSITIVE — serialize/deserialize round-trip WORKS in
WASM, verified before the keystone was reached):**
- Export: `sqlite3.capi.sqlite3_js_db_export(db.pointer)` →
  `Uint8Array` (a 3-commit/2-branch replica serialized to 7937 bytes).
- Import onto a fresh handle:
  `sqlite3.capi.sqlite3_deserialize(dbB.pointer, 'main', ptr, len, len, 3)`
  with `ptr = sqlite3.wasm.allocFromTypedArray(bytes)` (flags 1|2 =
  FREEONCLOSE|RESIZEABLE) → rc 0; imported handle's `dolt_log` messages,
  `dolt_branches` names (incl. the UNMERGED branch `x1`), and
  `dolt_hashof_db()` all EQUAL to the source replica
  (`39d96d55c678050bc8cd6258f13dbd8b48215af5` both sides).
- Alternate import: `sqlite3.capi.sqlite3_js_vfs_create_file('unix',
  '/probe-import.db', bytes, len)` (deprecated-but-working; warns to
  console) then `new oo1.DB('/probe-import.db')` → `dolt_hashof_db()`
  EQUAL.
- Commits on a deserialized handle work (`S4 → f58f9153…`).
- `SELECT name FROM pragma_function_list WHERE name LIKE 'dolt%'` (34
  names, WASM build): `dolt_add dolt_branch dolt_checkout
  dolt_cherry_pick dolt_clone dolt_commit dolt_config
  dolt_conflicts_resolve dolt_connect_branch dolt_creds dolt_creds_new
  dolt_default_branch dolt_fetch dolt_gc dolt_hashof
  dolt_hashof_catalog dolt_hashof_db dolt_hashof_table dolt_merge
  dolt_merge_base dolt_pull dolt_push dolt_rebase dolt_remote
  dolt_reset dolt_revert dolt_tag dolt_verify_constraints dolt_version
  doltlite_engine doltlite_internal_materialize_default_column`
  (catalog/db/table each appear twice in the raw list). So the remotes
  SYMBOLS are present in WASM; the machinery behind them is what's
  broken.

**What I tried:** six probe rounds (temporary `lp-probe.js`, deleted;
also fixed an unrelated flake in my /tmp runner — `server.kill()` on an
already-dead child now guarded). Sequence highlights: export→deserialize
equality (LP1 PASS substance), then remote add/fetch on fresh,
deserialized, and file-backed receivers; both fetch arities; pull;
clone into empty/non-empty; both URL forms; subdir attempt (blocked by
missing mkdir, recorded).

**Not tried (out of bounds per rules):** network research on the doltlite
issue tracker (LP README rule 8 restricts network to npm/jsr/astral),
patching the wasm package, worker-entry (`sqlite3-worker1-promiser`)
remotes, any protocol redesign (e.g. re-materializing the peer store as
the local db and diffing manually) — all are unlisted workarounds and
belong to the plan author.

**Decision needed:** LP2's choreography depends on `dolt_fetch` against a
`file://` remote in the same MEMFS. Options for the author (NOT
implemented): (a) report upstream (this entry is written to be
paste-ready for the doltlite tracker — the v0.11.53 WASM remote-IO
vtable appears unwired; native same-version works) and wait for a fixed
release; (b) sanction a different in-WASM convergence mechanism (e.g.
deserialize-peer-store + manual `dolt_merge` between two opened stores —
note merge across db handles is unproven and would itself be a spike);
(c) re-scope v0 to a non-Dolt reconciliation (out of plan's spirit).
LP3 (BroadcastChannel transport) is unaffected by this blocker and could
be built on request, but the LP→L4 gate (`LP SPIKES: 3/3 PASS`) cannot
pass while LP2 fails.

**RESOLVED 2026-08-24 by plan decision P-D1** (validator session
ses_fd2add951ffer9kl2Zf8K1WwZI under user delegation; recorded in
lite-p2p-sync plan.md §9, phase files updated by the decider): option D
+ superset adoption. LP2 splits into **LP2a (ACTIVE)** — probe-handle
superset check + wholesale adoption of a strictly-containing peer store
(= Dolt fast-forward semantics using only the LP1-proven
serialize/deserialize primitives; linear convergence provable now; a
negative control proves true forks are DETECTED, not adopted) — and
**LP2b (BLOCKED-UPSTREAM)** — the fetch-based fork heal kept verbatim as
the future drop-in; the deliverable for that half is the stub seam
`healFork()` throwing `E_FORK_HEAL_PENDING_UPSTREAM` plus a visible UI
state; check-p2p heal assertions park behind `--with-heal` (default
off). Option B (cross-handle merge) rejected on first principles (merge
operates on refs within one database; no cross-database union primitive
exists besides the broken remotes). Option C rejected as a spirit
violation. Upstream report is the user's channel (D5).
