#!/usr/bin/env bash
# LS1 — basics: dolt_config, schema (SQLite dialect: TEXT/INTEGER, JSON as
# TEXT + json1), insert, dolt_commit('-Am',...), dolt_log, dolt_version().
# Also verifies the CLI honors .headers/.mode dot-commands.
set -uo pipefail
DB="$1"
FAILED=0
ok()   { echo "CHECK OK $1 — $2"; }
fail() { echo "CHECK FAIL $1 — $2"; FAILED=1; }

OUT=$("$BIN" "$DB" <<'SQL'
.headers on
.mode list
SELECT dolt_config('user.name','POC');
SELECT dolt_config('user.email','poc@localhost');
SQL
)
echo "$OUT"
if echo "$OUT" | grep -qF "dolt_config('user.name','POC')"; then
  ok dot-commands ".headers on / .mode list honored (header row printed; list mode pipe-separated)"
else
  fail dot-commands "no header row in output: $OUT"
fi

OUT=$("$BIN" "$DB" <<'SQL'
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
INSERT INTO events VALUES ('$ls1e1','m.room.message',NULL,'@poc:local',1000,'{"type":"m.room.message","content":{"body":"hello ls1"}}');
INSERT INTO state VALUES ('m.room.topic','','$ls1e1','{"topic":"hello room"}');
SELECT dolt_commit('-Am','ls1');
SQL
)
echo "$OUT"
HASH=$(echo "$OUT" | grep -Eo '[0-9a-f]{40}' | head -1)
if [ -n "$HASH" ]; then
  ok commit-hash "dolt_commit('-Am','ls1') returned 40-hex: $HASH"
else
  fail commit-hash "no 40-hex hash in: $OUT"
fi

OUT=$("$BIN" "$DB" <<'SQL'
.headers on
.mode list
SELECT * FROM dolt_log;
SELECT COUNT(*) AS log_rows FROM dolt_log;
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q '|ls1$'; then
  ok log-ls1 "dolt_log contains message 'ls1' (columns: commit_hash|committer|email|date|message)"
else
  fail log-ls1 "'ls1' message missing from dolt_log: $OUT"
fi

OUT=$("$BIN" "$DB" "SELECT dolt_version();")
echo "$OUT"
if echo "$OUT" | grep -q '^v0\.11'; then
  ok version "dolt_version() → $OUT"
else
  fail version "unexpected: $OUT"
fi

OUT=$("$BIN" "$DB" "SELECT json_extract(canonical_json,'\$.type') FROM events;")
echo "$OUT"
if [ "$OUT" = "m.room.message" ]; then
  ok json-extract "json_extract(canonical_json,'\$.type') → m.room.message"
else
  fail json-extract "got: $OUT"
fi

exit $FAILED
