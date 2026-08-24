#!/usr/bin/env bash
# LS5 — time travel, using the two hashes from LS4's db (per phase file):
# dolt_at_events('<h>'), dolt_history_events (>=2 rows, commit metadata),
# dolt_diff_events('<h0>','<h1>') (>=1 row), dolt_hashof_db() (40-hex).
# $1 is LS4's db file (run.sh passes ls4.db; ls4.env sits beside it).
set -uo pipefail
DB="$1"
FAILED=0
ok()   { echo "CHECK OK $1 — $2"; }
fail() { echo "CHECK FAIL $1 — $2"; FAILED=1; }

# shellcheck disable=SC1091
source "$(dirname "$DB")/ls4.env"
echo "LS5 reusing LS4 db: $DB (H0=$H0 H1=$H1); reading on branch xevt"

echo "--- dolt_at_events('$H0') ---"
OUT=$("$BIN" "$DB@xevt" <<SQL
.headers on
.mode list
SELECT * FROM dolt_at_events('$H0');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q '^$ls4gen|' && [ "$(echo "$OUT" | wc -l)" = "2" ]; then
  ok at-events "dolt_at_events('$H0') returned the historical rowset (1 row: genesis event \$ls4gen)"
else
  fail at-events "unexpected rowset: $OUT"
fi

echo "--- dolt_history_events (full) ---"
OUT=$("$BIN" "$DB@xevt" <<'SQL'
.headers on
.mode list
SELECT * FROM dolt_history_events;
SQL
)
echo "$OUT"
N=$("$BIN" "$DB@xevt" "SELECT COUNT(*) FROM dolt_history_events;")
HDR=$(echo "$OUT" | head -1)
if [ "$N" -ge 2 ] && echo "$HDR" | grep -q 'commit_hash'; then
  ok history-events "dolt_history_events has $N (>=2) rows with commit metadata (columns: $HDR)"
else
  fail history-events "rows=$N header=$HDR"
fi

echo "--- dolt_diff_events('$H0','$H1') ---"
OUT=$("$BIN" "$DB@xevt" <<SQL
.headers on
.mode list
SELECT diff_type, to_event_id FROM dolt_diff_events('$H0','$H1');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q '^added|\$ls4e1$'; then
  ok diff-range "dolt_diff_events(h0,h1) >= 1 row (added \$ls4e1)"
else
  fail diff-range "got: $OUT"
fi

OUT=$("$BIN" "$DB@xevt" "SELECT dolt_hashof_db();")
echo "dolt_hashof_db() = $OUT"
if echo "$OUT" | grep -qE '^[0-9a-f]{40}$'; then
  ok hashof-db "dolt_hashof_db() returns 40-hex: $OUT"
else
  fail hashof-db "got: $OUT"
fi

exit $FAILED
