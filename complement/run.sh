#!/usr/bin/env bash
# complement/run.sh — build the image, apply the blacklist, run Complement,
# tally to complement/BASELINE.md. Usage: bash complement/run.sh [-run '<expr>'].
# Exit 0 when the HARNESS worked (image built, go test ran, baseline written)
# — red tests are the recorded baseline, not a harness error. The go test
# exit code is recorded in BASELINE.md.
# VM-only; requires Go, Docker, Deno and a Complement checkout.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
if [[ ! -f complement/Dockerfile || ! -f complement/entrypoint.sh || ! -f main.ts ]]; then
  echo "Complement runtime is not restored on this branch; see README.md." >&2
  exit 2
fi
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

# the baseline must be traceable to the tree it ran from: a real checkout,
# clean, and the header records exactly its commit (the committed 7dda306
# header — a stale checkout under an rsync'd tree — is how the untraceable
# baseline slipped through)
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "run.sh: $REPO_ROOT is not a git checkout — refusing (untraceable baseline)" >&2
  exit 1
fi
TREE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "run.sh: $REPO_ROOT has uncommitted changes — refusing (untraceable baseline):" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

# 1. build the image (the qualified native library is built in the VM,
# never fetched or compiled inside the runtime image).
if [[ ! -f .native/libturso_ffi.so ]]; then
  echo "run.sh: native library missing - run deno task native in the project VM first" >&2
  exit 1
fi
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
# Preview allowlist: the docker bridge subnet (host.docker.internal lives
# there). Discover it; never invent a CIDR.
BRIDGE_SUBNET="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Subnet}}')"
if [[ -z "$BRIDGE_SUBNET" ]]; then
  echo "docker bridge subnet not discoverable from run.sh — stop and ask" >&2
  exit 1
fi
echo ">> preview allowlist (docker bridge): $BRIDGE_SUBNET"
export COMPLEMENT_SHARE_ENV_PREFIX=PASS_
export PASS_COMMUNICO_PREVIEW_ENABLED=true
export PASS_COMMUNICO_PREVIEW_ALLOWLIST="$BRIDGE_SUBNET"
# The table owns both default-pass exclusions and each setting's environment.
# Values are env arguments, never shell code. Each row names a top-level test.
TESTS=()
SETTINGS=()
declare -A SEEN=()
while read -r test settings; do
  [[ -z "$test" || "$test" == \#* ]] && continue
  [[ "$test" =~ ^Test[A-Za-z0-9_]+$ && -n "$settings" ]] || { echo "invalid per-test setting: $test $settings" >&2; exit 1; }
  [[ -z "${SEEN[$test]:-}" ]] || { echo "duplicate per-test setting: $test" >&2; exit 1; }
  read -r -a overrides <<< "$settings"
  for override in "${overrides[@]}"; do
    [[ "$override" =~ ^PASS_COMMUNICO_[A-Z0-9_]+=.+$ ]] || { echo "invalid environment override: $override" >&2; exit 1; }
  done
  SEEN[$test]=1
  TESTS+=("$test")
  SETTINGS+=("$settings")
done < complement/settings.tsv

# Enumerate the compiled top-level tests once. This lets each settings pass
# keep the user's original -run expression (including subtest paths), while
# -skip excludes every other test. Go owns all regexp matching in both passes.
(
  cd "$WORK"
  COMPLEMENT_BASE_IMAGE="$IMAGE" go test -tags communico_blacklist -list '^Test' ./tests/...
) > "$WORK/list.log" 2>&1
mapfile -t ALL_TESTS < <(grep -E '^Test[A-Za-z0-9_]+$' "$WORK/list.log" | sort -u)
for test in "${TESTS[@]}"; do
  printf '%s\n' "${ALL_TESTS[@]}" | grep -Fx "$test" >/dev/null || { echo "configured test missing: $test" >&2; exit 1; }
done
skip_pattern() {
  local joined
  joined="$(IFS='|'; echo "$*")"
  if [[ -n "$joined" ]]; then printf '^(%s)$' "$joined"; else printf '^$'; fi
}
: > "$WORK/runs.tsv"
: > complement/baseline.jsonl
TEST_STATUS=0
run_pass() {
  local label=$1 test=$2 settings=$3 skip=$4 status
  local overrides=() filter=()
  [[ -z "$settings" ]] || read -r -a overrides <<< "$settings"
  [[ -z "$RUN_FILTER" ]] || filter=(-run "$RUN_FILTER")
  echo ">> running Complement ($label; filter: ${RUN_FILTER:-all}; settings: ${settings:-defaults})"
  set +e
  (
    cd "$WORK"
    env "${overrides[@]}" COMPLEMENT_BASE_IMAGE="$IMAGE" go test -count=1 -tags communico_blacklist -timeout 3h "${filter[@]}" -skip "$skip" -json ./tests/... 2>&1 | tee "$REPO_ROOT/$WORK/baseline-$label.jsonl"
    exit "${PIPESTATUS[0]}"
  )
  status=$?
  set -e
  cat "$WORK/baseline-$label.jsonl" >> complement/baseline.jsonl
  printf '%s\t%s\t%s\t%s\n' "$label" "$test" "$settings" "$status" >> "$WORK/runs.tsv"
  [[ "$status" == 0 ]] || TEST_STATUS=$status
  echo ">> $label go test exit: $status (recorded; harness exit stays 0)"
}
run_pass default '*' '' "$(skip_pattern "${TESTS[@]}")"
for i in "${!TESTS[@]}"; do
  excluded=()
  for test in "${ALL_TESTS[@]}"; do
    [[ "$test" == "${TESTS[$i]}" ]] || excluded+=("$test")
  done
  run_pass "settings-$((i + 1))" "${TESTS[$i]}" "${SETTINGS[$i]}" "$(skip_pattern "${excluded[@]}")"
done

# 4. tally to BASELINE.md (failures vs blacklist-skips distinguished)
deno eval --allow-read --allow-write '
const lines = (await Deno.readTextFile("complement/baseline.jsonl")).trim().split("\n");
let pass = 0, fail = 0, skip = 0;
const packages = new Map();
const tests = new Map();
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (!["pass", "fail", "skip"].includes(ev.Action)) continue;
  if (ev.Test) {
    const key = `${ev.Package} ${ev.Test}`;
    if (tests.has(key)) throw new Error(`duplicate terminal result: ${key}`);
    tests.set(key, ev.Action);
  } else {
    const prior = packages.get(ev.Package);
    packages.set(ev.Package, prior === "fail" || ev.Action === "fail" ? "fail" :
      prior === "pass" || ev.Action === "pass" ? "pass" : "skip");
  }
}
const failedPkgs = [...packages].filter(([, a]) => a === "fail").map(([p]) => p);
const failedTests = [...tests].filter(([, a]) => a === "fail").map(([t]) => t);
for (const action of packages.values()) {
  if (action === "pass") pass++;
  if (action === "fail") fail++;
  if (action === "skip") skip++;
}
const runs = (await Deno.readTextFile(Deno.args[4])).trim().split("\n")
  .map((line) => line.split("\t"));
const now = new Date().toISOString();
const out = `# Complement baseline - ${now}\n\n` +
  `- checkout: ~/Sources/matrix-org-complement @ ${Deno.args[0]}\n` +
  `- image: ${Deno.args[1]} (commit ${Deno.args[2]})\n` +
  `- go test exit: ${Deno.args[3]} (red tests are the baseline, not a harness error)\n` +
  `- packages: pass=${pass} fail=${fail} skip=${skip}\n` +
  `- failing tests: ${failedTests.length}\n\n` +
  `## Per-setting runs\n\n` +
  `The same image and checkout are used for every pass; the user filter applies to all passes.\n` +
  `Package totals above count each package once, failing if any pass fails.\n\n` +
  `| # | Pass | Test | Environment override | Go test exit |\n|---|---|---|---|---|\n` +
  runs.map(([label, test, settings, status], i) =>
    `| ${i + 1} | ${label} | ${test === "*" ? "All except configured tests" : test} | ${settings || "Defaults"} | ${status} |`).join("\n") + `\n\n` +
  `## Failing packages\n\n` +
  ([...failedPkgs].map((p) => `- ${p}`).join("\n") || "(none)") + `\n\n` +
  `## Failing tests (red to beat)\n\n` +
  (failedTests.map((t) => `- ${t}`).join("\n") || "(none)") + `\n`;
await Deno.writeTextFile("complement/BASELINE.md", out);
console.log(`baseline: ${pass} pass-pkgs, ${fail} fail-pkgs, ${skip} skip-pkgs, ${failedTests.length} failing tests`);
' "$PINNED" "$IMAGE" "$TREE_COMMIT" "$TEST_STATUS" "$WORK/runs.tsv"
rm -f complement/.test-status
echo ">> wrote complement/BASELINE.md"
