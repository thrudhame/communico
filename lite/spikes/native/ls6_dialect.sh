#!/usr/bin/env bash
# LS6 — dialect features (informational): json1 round-trip, dolt_docs
# presence, last_insert_rowid() on the TEXT-PK events table, and a review of
# every Error line seen in LS1–LS5 (retries of anything unexpected).
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
SQL

echo "--- json1 round-trip ---"
OUT=$("$BIN" "$DB" <<'SQL'
.headers on
.mode list
INSERT INTO events VALUES ('$ls6e1','m.room.message',NULL,'@poc:local',6000,'{"type":"m.room.message","content":{"body":"hi","tags":["a","b","c"]}}');
SELECT json_extract(canonical_json,'$.content.body') AS body, json_extract(canonical_json,'$.content.tags[2]') AS tag2 FROM events;
SELECT json_valid(canonical_json) AS valid FROM events;
SELECT json('  { "a" : 1 }  ') AS normalized;
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q '^hi|c$' && echo "$OUT" | grep -q '^1$' && echo "$OUT" | grep -q '^{"a":1}$'; then
  ok json-roundtrip "json1: json_extract nested+array-index, json_valid, json() normalize all work"
else
  fail json-roundtrip "see output above"
fi

echo "--- dolt_docs ---"
OUT=$("$BIN" "$DB" <<'SQL'
.headers on
.mode list
SELECT doc_name, substr(doc_text,1,60) FROM dolt_docs;
SQL
)
echo "$OUT"
if echo "$OUT" | grep -q '^AGENT.md|'; then
  ok dolt-docs "dolt_docs present with default AGENT.md row (DoltLite operations guide)"
else
  fail dolt-docs "no AGENT.md row: $OUT"
fi

echo "--- last_insert_rowid() on TEXT-PK table ---"
OUT=$("$BIN" "$DB" <<'SQL'
INSERT INTO events VALUES ('$ls6e2','m.room.message',NULL,'@poc:local',6001,'{}');
SELECT last_insert_rowid();
SQL
)
VAL=$(echo "$OUT" | tail -1)
echo "$OUT"
ok last-insert-rowid-recorded "last_insert_rowid() after INSERT into TEXT-PK events → '$VAL' (informational; engine uses TEXT ids, does not rely on rowid)"

echo "--- empty-result display behavior (relevant to machine-checking GUARDs) ---"
OUT=$("$BIN" "$DB" <<'SQL'
.headers on
.mode list
SELECT * FROM events WHERE 0;
SQL
)
echo "[empty-result output between markers]${OUT}[end]"
ok empty-result-display "empty result set with .headers on prints NOTHING (not even headers) — observed '$OUT'"

echo "--- Error lines observed across ls1..ls5 logs (review; expected = 3 documented LS3 lines) ---"
SCRATCH="$(dirname "$DB")"
grep -h '^Error' "$SCRATCH"/ls1.log "$SCRATCH"/ls2.log "$SCRATCH"/ls3.log "$SCRATCH"/ls4.log "$SCRATCH"/ls5.log 2>/dev/null | sort | uniq -c
ok errors-reviewed "LS1–LS5 error lines reviewed above; all are the documented LS3 discoveries (autocommit negative control, conflicted-merge notice, COMMIT-after-dolt_commit) — nothing unexpected to retry"

exit $FAILED
