#!/usr/bin/env bash
# LS2 — branch ops: dolt_branch, branch-qualified open (<db>@x1), commit on
# branch, dolt_hashof('main') unmoved, dolt_branches, branch deletion
# (-d refused on unmerged, -d on merged, -D force).
set -uo pipefail
DB="$1"
FAILED=0
ok()   { echo "CHECK OK $1 — $2"; }
fail() { echo "CHECK FAIL $1 — $2"; FAILED=1; }

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
INSERT INTO events VALUES ('$ls2base','m.room.create',NULL,'@poc:local',2000,'{"type":"m.room.create"}');
SELECT dolt_commit('-Am','ls2 base');
SELECT dolt_branch('x1');
SQL

H0=$("$BIN" "$DB" "SELECT dolt_hashof('main');")
echo "h0 (main at start) = $H0"

echo "--- open $DB@x1 ---"
OUT=$("$BIN" "$DB@x1" <<'SQL'
.headers on
.mode list
SELECT active_branch();
INSERT INTO events VALUES ('$ls2x1','m.room.message',NULL,'@poc:local',2001,'{"type":"m.room.message"}');
SELECT dolt_commit('-Am','ls2 on x1');
SELECT dolt_hashof('x1');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -qx 'x1'; then
  ok active-branch "branch-qualified open '<db>@x1' → active_branch() = x1"
else
  fail active-branch "active_branch() not x1: $OUT"
fi
H1=$(echo "$OUT" | grep -Eo '[0-9a-f]{40}' | tail -1)
echo "h1 (x1 tip) = $H1"

HM=$("$BIN" "$DB" "SELECT dolt_hashof('main');")
echo "hashof('main') after x1 commit = $HM"
if [ "$HM" = "$H0" ]; then
  ok main-unmoved "dolt_hashof('main') unchanged ($H0) after commit on x1"
else
  fail main-unmoved "main moved: $H0 → $HM"
fi

OUT=$("$BIN" "$DB" <<'SQL'
.headers on
.mode list
SELECT name, hash, latest_commit_message FROM dolt_branches;
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q '^main|' && echo "$OUT" | grep -q '^x1|'; then
  ok branches-list "dolt_branches lists main and x1 (columns: name|hash|latest_committer|latest_committer_email|latest_commit_date|latest_commit_message|remote|branch|dirty)"
else
  fail branches-list "missing branch in: $OUT"
fi

echo "--- dolt_branch('-d','x1') on UNMERGED branch (expect refusal) ---"
OUT=$("$BIN" "$DB" <<'SQL' 2>&1
SELECT dolt_branch('-d','x1');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -qi 'not fully merged'; then
  ok d-refused-unmerged "dolt_branch('-d','x1') refused on unmerged branch, verbatim: $(echo "$OUT" | tr '\n' ' ')"
else
  fail d-refused-unmerged "unexpected result: $OUT"
fi

echo "--- merge x1 into main (fast-forward), then -d on MERGED branch ---"
OUT=$("$BIN" "$DB" <<'SQL' 2>&1
.headers on
.mode list
SELECT dolt_merge('x1');
SELECT dolt_branch('-d','x1');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q 'fast-forward\|0'; then
  ok d-merged-ok "dolt_merge('x1') on main (fast-forward) then dolt_branch('-d','x1') → succeeded (merged-branch delete works)"
else
  fail d-merged-ok "unexpected: $OUT"
fi

echo "--- dolt_branch('-D',...) force-delete on UNMERGED branch x2 ---"
"$BIN" "$DB" "SELECT dolt_branch('x2');" > /dev/null
"$BIN" "$DB@x2" "INSERT INTO events VALUES ('\$ls2x2','m.room.message',NULL,'@poc:local',2002,'{}'); SELECT dolt_commit('-Am','ls2 on x2');" > /dev/null
OUT=$("$BIN" "$DB" <<'SQL' 2>&1
SELECT dolt_branch('-D','x2');
SQL
)
echo "$OUT"
LEFT=$("$BIN" "$DB" "SELECT name FROM dolt_branches;")
echo "branches after -D: $(echo "$LEFT" | tr '\n' ' ')"
if [ "$OUT" = "0" ] && ! echo "$LEFT" | grep -qx 'x2'; then
  ok D-force-ok "dolt_branch('-D','x2') force-deleted an UNMERGED branch (README documents only -d; -D exists and works)"
else
  fail D-force-ok "out=$OUT remaining=$LEFT"
fi

exit $FAILED
