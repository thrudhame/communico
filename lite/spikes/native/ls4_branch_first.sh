#!/usr/bin/env bash
# LS4 — branch-first ingest (D8 pattern): branch at HEAD → reopen db@branch
# → insert event row + state upsert + commit → prev branch's dolt_hashof
# unmoved; commit-per-event invariant via dolt_diff_events('HEAD~1','HEAD')
# = exactly 1 added row. Persists hashes to ls4.env for LS5.
set -uo pipefail
DB="$1"
FAILED=0
ok()   { echo "CHECK OK $1 — $2"; }
fail() { echo "CHECK FAIL $1 — $2"; FAILED=1; }

OUT=$("$BIN" "$DB" <<'SQL'
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
INSERT INTO events VALUES ('$ls4gen','m.room.create',NULL,'@poc:local',4000,'{"type":"m.room.create","content":{"creator":"@poc:local"}}');
SELECT dolt_commit('-Am','ls4 genesis');
SELECT dolt_branch('xevt');
SQL
)
echo "$OUT"
H0=$("$BIN" "$DB" "SELECT dolt_hashof('main');")
echo "h0 (main HEAD at branch time) = $H0"

echo "--- branch-first: reopen $DB@xevt, insert event + state upsert, commit ---"
OUT=$("$BIN" "$DB@xevt" <<'SQL'
.headers on
.mode list
INSERT INTO events VALUES ('$ls4e1','m.room.message',NULL,'@poc:local',4001,'{"type":"m.room.message","content":{"body":"first event on branch"}}');
INSERT OR REPLACE INTO state VALUES ('m.room.topic','','$ls4e1','{"topic":"branch-first"}');
SELECT dolt_commit('-Am','ls4 event 1');
SELECT dolt_hashof('xevt');
SQL
)
echo "$OUT"
H1=$(echo "$OUT" | grep -Eo '[0-9a-f]{40}' | tail -1)
if [ -n "$H1" ] && [ "$H1" != "$H0" ]; then
  ok xevt-commit "commit on xevt branch: $H1"
else
  fail xevt-commit "bad hash: '$H1' (h0=$H0)"
fi

HM=$("$BIN" "$DB" "SELECT dolt_hashof('main');")
echo "hashof('main') after branch commit = $HM"
if [ "$HM" = "$H0" ]; then
  ok main-unmoved "prev branch pointer unmoved: dolt_hashof('main') = $H0"
else
  fail main-unmoved "main moved: $H0 → $HM"
fi

echo "--- commit-per-event invariant: dolt_diff_events('HEAD~1','HEAD') on xevt ---"
OUT=$("$BIN" "$DB@xevt" <<'SQL'
.headers on
.mode list
SELECT * FROM dolt_diff_events('HEAD~1','HEAD');
SQL
)
echo "$OUT"
DT=$("$BIN" "$DB@xevt" "SELECT diff_type FROM dolt_diff_events('HEAD~1','HEAD');")
if [ "$DT" = "added" ]; then
  ok diff-one-added "dolt_diff_events('HEAD~1','HEAD') = exactly 1 row, diff_type 'added'"
else
  fail diff-one-added "diff_type rows: '$DT'"
fi

echo "H0=$H0" >  "$(dirname "$DB")/ls4.env"
echo "H1=$H1" >> "$(dirname "$DB")/ls4.env"
echo "wrote $(dirname "$DB")/ls4.env for LS5 (H0=$H0 H1=$H1)"

exit $FAILED
