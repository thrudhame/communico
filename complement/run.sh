#!/usr/bin/env bash
# complement/run.sh — build the image, apply the blacklist, run Complement,
# tally to complement/BASELINE.md. Usage: bash complement/run.sh [-run '<expr>'].
# Exit 0 when the HARNESS worked (image built, go test ran, baseline written)
# — red tests are the recorded baseline, not a harness error. The go test
# exit code is recorded in BASELINE.md.
# Prereqs (verified on this host): Go 1.27, Docker 29.7, Complement checkout
# at ~/Sources/matrix-org-complement. Host runs approved (R10).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
eval "$(deno task -q config -- --shell)"
COMPLEMENT_SRC="${COMPLEMENT_SRC:-$HOME/Sources/matrix-org-complement}"
IMAGE="${COMPLEMENT_IMAGE:-communico-complement:local}"
RUN_FILTER=""
if [[ "${1:-}" == "-run" ]]; then
  RUN_FILTER="${2:-}"
fi

command -v go >/dev/null || { echo "go not found" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
[[ -d "$COMPLEMENT_SRC" ]] || { echo "Complement checkout missing: $COMPLEMENT_SRC" >&2; exit 1; }
PINNED="$(git -C "$COMPLEMENT_SRC" rev-parse --short HEAD)"

# 1. build the image
echo ">> building $IMAGE"
docker build -t "$IMAGE" -f complement/Dockerfile .

# 2. scratch copy of the checkout (the human blacklist.md is the source;
#    the user's checkout is never mutated) + machine-form build tags
WORK="complement/work-$PINNED"
rm -rf "$WORK" complement/.test-status
mkdir -p "$WORK"
echo ">> copying Complement checkout to $WORK"
git -C "$COMPLEMENT_SRC" archive HEAD | tar -x -C "$WORK"
echo ">> applying blacklist tags"
APPLIED=0
SKIPPED_MISSING=0
while IFS= read -r line; do
  f="${line#- }"
  [[ "$f" == "$line" ]] && continue
  [[ "$f" == tests/* ]] || continue
  path="$WORK/$f"
  if [[ -f "$path" ]]; then
    if head -1 "$path" | grep -q 'communico_blacklist'; then
      : # already tagged (re-run over an existing work dir)
    elif head -5 "$path" | grep -q '^//go:build '; then
      # Go allows exactly one //go:build line: AND our exclusion into it.
      # (No parens: this checkout's constraints are plain negations and
      # gofmt/vet reject the redundant-paren form.)
      sed -i -E '0,/^\/\/go:build /s|^//go:build (.*)|//go:build !communico_blacklist \&\& \1|' "$path"
    else
      sed -i '1i //go:build !communico_blacklist\n' "$path"
    fi
    # Legacy // +build lines must match //go:build (vet enforces it);
    # tagged files are excluded from the build either way, so drop them.
    sed -i '/^\/\/ +build /d' "$path"
    APPLIED=$((APPLIED + 1))
  else
    echo "   blacklist entry missing in checkout: $f" >&2
    SKIPPED_MISSING=$((SKIPPED_MISSING + 1))
  fi
done < <(grep -E '^- tests/' complement/blacklist.md)
echo "   tags applied: $APPLIED, missing: $SKIPPED_MISSING"

# 3. run Complement (go-test failures are red baseline, not harness errors).
# -timeout 3h: the csapi package runs its tests sequentially and every test
# spawns a fresh container (~8s); the default 10m go timeout would kill it.
echo ">> running Complement (filter: ${RUN_FILTER:-all})"
set +e
(
  cd "$WORK"
  if [[ -n "$RUN_FILTER" ]]; then
    COMPLEMENT_BASE_IMAGE="$IMAGE" go test -tags communico_blacklist -timeout 3h -run "$RUN_FILTER" -json ./tests/... 2>&1 | tee "$REPO_ROOT/complement/baseline.jsonl"
  else
    COMPLEMENT_BASE_IMAGE="$IMAGE" go test -tags communico_blacklist -timeout 3h -json ./tests/... 2>&1 | tee "$REPO_ROOT/complement/baseline.jsonl"
  fi
  echo "${PIPESTATUS[0]}" > "$REPO_ROOT/complement/.test-status"
)
set -e
TEST_STATUS="$(cat complement/.test-status)"
echo ">> go test exit: $TEST_STATUS (recorded; harness exit stays 0)"

# 4. tally to BASELINE.md (failures vs blacklist-skips distinguished)
deno eval --allow-read --allow-write '
const lines = (await Deno.readTextFile("complement/baseline.jsonl")).trim().split("\n");
let pass = 0, fail = 0, skip = 0;
const failedPkgs = new Set();
const failedTests = [];
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.Action === "pass" && !ev.Test) pass++;
  if (ev.Action === "fail" && !ev.Test) { fail++; failedPkgs.add(ev.Package); }
  if (ev.Action === "skip" && !ev.Test) skip++;
  if (ev.Action === "fail" && ev.Test) failedTests.push(`${ev.Package} ${ev.Test}`);
}
const now = new Date().toISOString();
const out = `# Complement baseline — ${now}\n\n` +
  `- checkout: ~/Sources/matrix-org-complement @ ${Deno.args[0]}\n` +
  `- image: ${Deno.args[1]} (commit ${Deno.args[2]})\n` +
  `- go test exit: ${Deno.args[3]} (red tests are the baseline, not a harness error)\n` +
  `- packages: pass=${pass} fail=${fail} skip=${skip}\n` +
  `- failing tests: ${failedTests.length}\n\n` +
  `## Failing packages\n\n` +
  ([...failedPkgs].map((p) => `- ${p}`).join("\n") || "(none)") + `\n\n` +
  `## Failing tests (red to beat)\n\n` +
  (failedTests.map((t) => `- ${t}`).join("\n") || "(none)") + `\n`;
await Deno.writeTextFile("complement/BASELINE.md", out);
console.log(`baseline: ${pass} pass-pkgs, ${fail} fail-pkgs, ${skip} skip-pkgs, ${failedTests.length} failing tests`);
' "$PINNED" "$IMAGE" "$(git rev-parse --short HEAD)" "$TEST_STATUS"
rm -f complement/.test-status
echo ">> wrote complement/BASELINE.md"
