#!/usr/bin/env bash
# LS3 — merge driver (THE KEYSTONE): conflicting state rows on ma/mb;
# explicit-transaction conflict model; driver-resolved merge; verified live,
# via dolt_at_state(dolt_hashof('ma')), and by 2-parent reachability.
# Discovery items: negative control (autocommit), dolt_commit vs COMMIT
# ordering (both candidate orderings exercised).
set -uo pipefail
DB="$1"
FAILED=0
ok()   { echo "CHECK OK $1 — $2"; }
fail() { echo "CHECK FAIL $1 — $2"; FAILED=1; }

# --- setup: base commit, branches ma/mb, conflicting commits -------------
"$BIN" "$DB" > /dev/null <<'SQL'
SELECT dolt_config('user.name','POC');
SELECT dolt_config('user.email','poc@localhost');
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL, state_key TEXT, sender TEXT NOT NULL,
  origin_ts INTEGER NOT NULL, canonical_json TEXT NOT NULL
);
CREATE TABLE state (
  type TEXT NOT NULL, state_key TEXT NOT NULL,
  event_id TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (type, state_key)
);
INSERT INTO state VALUES ('m.room.topic','','$base','origin');
SELECT dolt_commit('-Am','ls3 base');
SELECT dolt_branch('ma');
SELECT dolt_branch('mb');
SQL
"$BIN" "$DB@ma" "UPDATE state SET content='cats', event_id='\$ma1' WHERE type='m.room.topic'; SELECT dolt_commit('-Am','cats');" > /dev/null
"$BIN" "$DB@mb" "UPDATE state SET content='dogs', event_id='\$mb1' WHERE type='m.room.topic'; SELECT dolt_commit('-Am','dogs');" > /dev/null
echo "setup done: base/ma(cats)/mb(dogs)"

# --- NEGATIVE CONTROL: conflicted merge in autocommit mode ---------------
echo "--- NEGATIVE CONTROL: dolt_merge('mb') in autocommit (no BEGIN) ---"
OUT=$("$BIN" "$DB@ma" <<'SQL' 2>&1
SELECT dolt_merge('mb');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q 'cannot merge: conflicts detected, autocommit transaction rolled back'; then
  ok neg-control "autocommit conflicted merge refused, verbatim: $(echo "$OUT" | tr '\n' ' ')"
else
  fail neg-control "expected documented rollback error, got: $OUT"
fi
C=$("$BIN" "$DB@ma" "SELECT content FROM state WHERE type='m.room.topic';")
echo "live content after autocommit rollback: $C"
if [ "$C" = "cats" ]; then
  ok neg-control-rollback "working state unchanged after rollback (content still 'cats')"
else
  fail neg-control-rollback "content is '$C', expected 'cats'"
fi

# --- EXPLICIT TRANSACTION (phase ordering: dolt_commit INSIDE, then COMMIT)
echo "--- explicit transaction: BEGIN; merge; conflicts; resolve; update; GUARD; dolt_commit; COMMIT ---"
OUT=$("$BIN" "$DB@ma" <<'SQL' 2>&1
.headers on
.mode list
BEGIN;
SELECT dolt_merge('mb');
SELECT * FROM dolt_conflicts;
SELECT * FROM dolt_conflicts_state;
SELECT dolt_conflicts_resolve('--ours','state');
UPDATE state SET content='DRIVER-DECIDED' WHERE type='m.room.topic';
SELECT * FROM dolt_conflicts;
SELECT COUNT(*) AS guard_n FROM dolt_conflicts;
SELECT dolt_commit('-Am','ls3 merge with driver content');
COMMIT;
SQL
)
echo "$OUT"

if echo "$OUT" | grep -q 'Merge has 1 conflict(s)' && echo "$OUT" | grep -q $'state|1'; then
  ok merge-conflict-held "dolt_merge inside BEGIN reports 'Merge has 1 conflict(s). Resolve and then commit with dolt_commit.' as an error-line BUT conflict state is held (dolt_conflicts: state|1); shell continues with subsequent statements"
else
  fail merge-conflict-held "see output above"
fi
if echo "$OUT" | grep -q 'dolt_conflict_id' && echo "$OUT" | grep -q 'our_diff_type'; then
  ok conflicts-state-seen "dolt_conflicts_state columns: from_root_ish|base_type|base_state_key|base_event_id|base_content|our_*|our_diff_type|their_*|their_diff_type|dolt_conflict_id (full row in log above)"
else
  fail conflicts-state-seen "dolt_conflicts_state header unexpected"
fi
if echo "$OUT" | grep -A1 "dolt_conflicts_resolve('--ours','state')" | grep -q '^0$'; then
  ok resolve-ok "dolt_conflicts_resolve('--ours','state') → 0"
else
  fail resolve-ok "see output above"
fi
if echo "$OUT" | grep -q $'guard_n\n0'; then
  ok guard-empty "GUARD: dolt_conflicts empty after resolve (COUNT(*)=0; note: empty SELECT with .headers on prints NOTHING, not even headers — count form used for machine check)"
else
  fail guard-empty "conflicts not cleared"
fi
MERGEH=$(echo "$OUT" | grep -Eo '[0-9a-f]{40}' | tail -1)
TIP=$("$BIN" "$DB@ma" "SELECT dolt_hashof('ma');")
if [ -n "$MERGEH" ] && [ "$MERGEH" = "$TIP" ]; then
  ok merge-hash "dolt_commit('-Am','ls3 merge with driver content') INSIDE the txn returned $MERGEH == dolt_hashof('ma')"
else
  fail merge-hash "in-band hash '$MERGEH' vs hashof(ma) '$TIP'"
fi
if echo "$OUT" | grep -q 'cannot commit - no transaction is active'; then
  ok txn-ordering "ORDERING DISCOVERY: dolt_commit INSIDE BEGIN..COMMIT finalizes the SQL transaction itself; a following COMMIT errors 'cannot commit - no transaction is active' (harmless, recorded)"
else
  fail txn-ordering "expected COMMIT-after-dolt_commit error not seen"
fi

# --- PASS assertions -------------------------------------------------------
C=$("$BIN" "$DB@ma" "SELECT content FROM state WHERE type='m.room.topic';")
echo "live content: $C"
[ "$C" = "DRIVER-DECIDED" ] && ok live-driver "live state.content = 'DRIVER-DECIDED'" || fail live-driver "content=$C"

OUT=$("$BIN" "$DB@ma" <<'SQL'
SELECT content FROM dolt_at_state(dolt_hashof('ma')) WHERE type='m.room.topic';
SQL
)
echo "dolt_at_state(dolt_hashof('ma')): $OUT"
[ "$OUT" = "DRIVER-DECIDED" ] && ok asof-driver "dolt_at_state(dolt_hashof('ma')).content = 'DRIVER-DECIDED'" || fail asof-driver "got: $OUT"

OUT=$("$BIN" "$DB@ma" "SELECT message FROM dolt_log;")
echo "dolt_log messages on ma: $(echo "$OUT" | tr '\n' ' | ')"
echo "$OUT" | grep -qx 'cats' && ok reach-cats "dolt_log('ma') contains 'cats' commit" || fail reach-cats "$OUT"
echo "$OUT" | grep -qx 'dogs' && ok reach-dogs "dolt_log('ma') contains 'dogs' commit (2-parent reachability)" || fail reach-dogs "$OUT"

echo "--- informational parent inspection candidates ---"
OUT=$("$BIN" "$DB@ma" "SELECT message FROM dolt_log('ma^2');" 2>&1)
echo "dolt_log('ma^2'): $(echo "$OUT" | tr '\n' ' | ')"
echo "$OUT" | grep -qx 'dogs' && ok parent-caret2 "dolt_log('ma^2') walks the SECOND parent's history (shows 'dogs')" || fail parent-caret2 "$OUT"
OUT=$("$BIN" "$DB@ma" "SELECT message FROM dolt_log('mb..ma');" 2>&1)
echo "dolt_log('mb..ma'): $(echo "$OUT" | tr '\n' ' | ')"
if echo "$OUT" | grep -q 'ls3 merge with driver content' && echo "$OUT" | grep -qx 'cats' && ! echo "$OUT" | grep -qx 'dogs'; then
  ok parent-range "dolt_log('mb..ma') range form works (merge+cats, excludes mb-reachable 'dogs')"
else
  fail parent-range "$OUT"
fi

# --- DISCOVERY: the AGENT.md-documented ordering (COMMIT then dolt_commit)
echo "--- ordering variant B (dolt_docs/AGENT.md documented): BEGIN; merge; resolve; update; COMMIT; dolt_commit ---"
"$BIN" "$DB" "SELECT dolt_branch('mc'); SELECT dolt_branch('md');" > /dev/null
"$BIN" "$DB@mc" "UPDATE state SET content='catsB', event_id='\$mc1' WHERE type='m.room.topic'; SELECT dolt_commit('-Am','catsB');" > /dev/null
"$BIN" "$DB@md" "UPDATE state SET content='dogsB', event_id='\$md1' WHERE type='m.room.topic'; SELECT dolt_commit('-Am','dogsB');" > /dev/null
OUT=$("$BIN" "$DB@mc" <<'SQL' 2>&1
BEGIN;
SELECT dolt_merge('md');
SELECT dolt_conflicts_resolve('--ours','state');
UPDATE state SET content='DOC-ORDER-OK' WHERE type='m.room.topic';
COMMIT;
SELECT dolt_commit('-Am','ls3 doc-order merge');
SQL
)
echo "$OUT"
C=$("$BIN" "$DB@mc" "SELECT content FROM state WHERE type='m.room.topic';")
LOGS=$("$BIN" "$DB@mc" "SELECT message FROM dolt_log;")
echo "doc-order live content: $C ; log: $(echo "$LOGS" | tr '\n' ' | ')"
if [ "$C" = "DOC-ORDER-OK" ] && echo "$LOGS" | grep -qx 'catsB' && echo "$LOGS" | grep -qx 'dogsB'; then
  ok txn-ordering-doc "ORDERING VARIANT B ALSO WORKS (COMMIT before dolt_commit): merge commit lands with both parents reachable; merge metadata survives COMMIT in-session"
else
  fail txn-ordering-doc "content=$C logs=$LOGS"
fi

exit $FAILED
