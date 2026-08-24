#!/usr/bin/env bash
# L0 runner: executes each native spike against a FRESH db file under
# /tmp/lite-spikes/ (LS5 excepted — the phase file has it reuse LS4's db),
# captures every statement's output to /tmp/lite-spikes/lsN.log, greps the
# expected per-spike CHECK markers, prints SPIKE LSn: PASS|FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BIN="$(cd "$HERE/../../bin" && pwd)/doltlite"
SCRATCH=/tmp/lite-spikes
mkdir -p "$SCRATCH"

echo "binary: $BIN ($("$BIN" --version))"
echo "scratch: $SCRATCH"

declare -A EXPECT=(
  [1]="dot-commands commit-hash log-ls1 version json-extract"
  [2]="active-branch main-unmoved branches-list d-refused-unmerged d-merged-ok D-force-ok"
  [3]="neg-control neg-control-rollback merge-conflict-held conflicts-state-seen resolve-ok guard-empty merge-hash txn-ordering live-driver asof-driver reach-cats reach-dogs parent-caret2 parent-range txn-ordering-doc"
  [4]="xevt-commit main-unmoved diff-one-added"
  [5]="at-events history-events diff-range hashof-db"
  [6]="json-roundtrip dolt-docs last-insert-rowid-recorded empty-result-display errors-reviewed"
)

OVERALL=0
for n in 1 2 3 4 5 6; do
  SCRIPT=$(ls "$HERE"/ls${n}_*.sh)
  DB="$SCRATCH/ls${n}.db"
  LOG="$SCRATCH/ls${n}.log"
  if [ "$n" = "5" ]; then
    DB="$SCRATCH/ls4.db"   # phase file: LS5 uses two hashes from LS4's db
  else
    rm -f "$DB"
  fi
  bash "$SCRIPT" "$DB" > "$LOG" 2>&1
  RC=$?
  BAD=0
  for key in ${EXPECT[$n]}; do
    if ! grep -q "^CHECK OK $key " "$LOG"; then
      echo "  LS$n missing marker '$key' (log: $LOG)"
      BAD=1
    fi
  done
  if grep -q "^CHECK FAIL " "$LOG"; then
    grep "^CHECK FAIL " "$LOG"
    BAD=1
  fi
  if [ "$RC" -eq 0 ] && [ "$BAD" -eq 0 ]; then
    echo "SPIKE LS$n: PASS"
  else
    echo "SPIKE LS$n: FAIL (script exit $RC; log: $LOG)"
    OVERALL=1
  fi
done
exit $OVERALL
