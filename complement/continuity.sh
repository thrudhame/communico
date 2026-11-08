#!/usr/bin/env bash
# Restart the SAME container; prove key-document signature continuity and
# persisted user/event state through HTTP. No second process opens the store.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NAME="${CONTINUITY_NAME:-cc-continuity}"
SERVER_NAME="${CONTINUITY_SERVER:-cont.local}"
IMAGE="${COMPLEMENT_IMAGE:-communico-complement:local}"

wait_ready() {
  for i in $(seq 1 90); do
    if timeout 5s docker exec "$NAME" curl -sf --max-time 3 localhost:8008/_matrix/client/versions >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  timeout 10s docker logs "$NAME" >&2
  echo "container never healthy" >&2
  return 1
}

timeout 15s docker rm -f "$NAME" >/dev/null 2>&1 || true
echo ">> starting $NAME ($SERVER_NAME)"
timeout 30s docker run -d --name "$NAME" -e SERVER_NAME="$SERVER_NAME" "$IMAGE" >/dev/null
wait_ready
BEFORE=$(timeout 90s docker exec -w /app "$NAME" \
  deno run --allow-net --allow-env complement/continuity.ts before)
echo ">> captured key document, registered user and event through HTTP"

echo ">> restarting the SAME container"
timeout 45s docker stop -t 30 "$NAME" >/dev/null
timeout 30s docker start "$NAME" >/dev/null
wait_ready
timeout 90s docker exec -w /app -e C_BEFORE="$BEFORE" "$NAME" \
  deno run --allow-net --allow-env complement/continuity.ts after
echo "CONTINUITY: PASS"
timeout 45s docker stop -t 30 "$NAME" >/dev/null
timeout 15s docker rm "$NAME" >/dev/null
