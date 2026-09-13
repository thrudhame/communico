#!/usr/bin/env bash
# demo/setup.sh — recreate the communico Matrix-on-Doltgres demo from a
# clean clone. Idempotent; --reset tears everything down first.
# Prereqs: Docker. Run from anywhere; the script cd's to the repo root
# (its parent's parent).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# the demo reads the dev environment rather than repeating it (.env.example
# documents the keys; the real environment wins over the file)
set -a; . ./.env; set +a
CONTAINER=communico-dev
IMAGE=communico:devcontainer
MC_IMAGE=matrixcommander/matrix-commander

if [[ "${1:-}" == "--reset" ]]; then
  echo ">> --reset: removing container and client state"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # best effort: client stores hold root-owned files (written by the
  # client containers) — step 6's throwaway-container cleanup handles
  # those; this rm is for the user-owned bulk
  rm -rf /tmp/mc-alice /tmp/mc-bob 2>/dev/null || true
fi

# 1. preflight
command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  for port in "${DB_PORT}" "${APP_PORT}"; do
    if ss -tln 2>/dev/null | grep -q ":${port} "; then
      echo "port ${port} is busy and $CONTAINER is not running" >&2
      exit 1
    fi
  done
fi

# 2. image + container (skip if already running)
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo ">> building $IMAGE"
  docker build -t "$IMAGE" .devcontainer
fi
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo ">> container $CONTAINER already running — skipping create"
else
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo ">> starting $CONTAINER"
  docker run -d --name "$CONTAINER" \
    --memory=8g --memory-swap=8g --pids-limit=512 --cpus=4 \
    --env-file .env \
    -e DOLTGRES_USER="${DB_USER}" -e DOLTGRES_PASSWORD="${DB_PASS}" -e DOLTGRES_DB="${DB_NAME}" \
    -p "${DB_PORT}:5432" -p "${APP_PORT}:${APP_PORT}" \
    -v "$PWD/doltgres/config:/etc/doltgres/servercfg.d" \
    -v "$PWD:/workspace" \
    "$IMAGE" sleep infinity
fi

# 3. Doltgres + app, with readiness waits
echo ">> starting Doltgres (A)"
docker exec -d "$CONTAINER" bash -c \
  'cd /workspace && doltgres --config /etc/doltgres/servercfg.d/config.yaml > /tmp/doltgres.log 2>&1'
echo ">> waiting for Doltgres (30s budget)"
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" bash -c \
    "cd /workspace && deno eval \"
      import pgpkg from 'pg';
      const c = new pgpkg.Client({host:'127.0.0.1',port:5432,user:'root',password:'secret',database:'postgres'});
      await c.connect(); await c.query('SELECT 1'); await c.end();
    \" >/dev/null 2>&1"; then
    break
  fi
  [[ $i == 30 ]] && { echo "Doltgres did not come up" >&2; exit 1; }
  sleep 1
done

echo ">> starting app (A)"
docker exec -d "$CONTAINER" bash -c \
  'cd /workspace && exec deno task start > /tmp/app-a.log 2>&1'
echo ">> waiting for app on :8008 (30s budget)"
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" curl -sf localhost:8008/ >/dev/null 2>&1; then
    break
  fi
  [[ $i == 30 ]] && { echo "app did not come up" >&2; exit 1; }
  sleep 1
done

# 4. provision server DB (seeds @alice/@bob, password 'demo-password')
echo ">> db-init"
docker exec "$CONTAINER" bash -c 'cd /workspace && deno task db-init'

# 5. demo room — reuse an existing native room if present so re-runs
#    print a stable room id (room_version is hat-facing metadata only;
#    event identity is content-hash for every room — design §4.1.1)
ROOM_ID="$(docker exec "$CONTAINER" bash -c \
  "cd /workspace && deno eval \"
    import pgpkg from 'pg';
    const c = new pgpkg.Client({host:'127.0.0.1',port:5432,user:'root',password:'secret',database:'postgres'});
    await c.connect();
    const r = await c.query(\\\"SELECT room_id FROM event_index WHERE room_id IN (SELECT room_id FROM room_directory WHERE room_version='11') GROUP BY room_id ORDER BY MAX(seq) DESC LIMIT 1;\\\");
    if (r.rows.length) console.log(r.rows[0].room_id);
    await c.end();
  \" 2>/dev/null | tail -1" || true)"
if [[ -z "$ROOM_ID" ]]; then
  echo ">> creating demo room"
  ROOM_ID="$(docker exec "$CONTAINER" curl -s -X POST localhost:8008/_matrix/client/v3/createRoom \
    -H 'Authorization: Bearer devtoken' \
    -d '{"room_version":"11"}' \
    | grep -o '"room_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
fi
echo ">> demo room: $ROOM_ID"

# 6. matrix-commander image + non-interactive logins
if ! docker image inspect "$MC_IMAGE" >/dev/null 2>&1; then
  echo ">> pulling $MC_IMAGE"
  docker pull "$MC_IMAGE" >/dev/null
fi
mkdir -p /tmp/mc-alice /tmp/mc-bob /tmp/mc-alice-send /tmp/mc-bob-send
# no stale data (plan Q2): drop persisted client stores — they hold
# since-tokens from any previous server instance, which would make
# --listen wait for events that "already happened" on the fresh server.
# Store files are root-owned (written by the client container), so
# remove them via a throwaway container.
for d in /tmp/mc-alice /tmp/mc-bob /tmp/mc-alice-send /tmp/mc-bob-send; do
  docker run --rm -v "$d:/data:z" --entrypoint rm "$MC_IMAGE" -rf /data/store /data/credentials.json || true
done
mc() {
  local store=$1; shift
  docker run --rm --network "container:$CONTAINER" \
    -v "$store:/data:z" -w /data "$MC_IMAGE" "$@" \
    --store /data/store --credentials /data/credentials.json >/dev/null
}
echo ">> logging in alice + bob (listen + send stores each)"
mc /tmp/mc-alice --login password --homeserver http://localhost:8008 \
  --user-login '@alice:localhost' --password 'demo-password' \
  --device alice-listen --room-default "$ROOM_ID"
mc /tmp/mc-alice-send --login password --homeserver http://localhost:8008 \
  --user-login '@alice:localhost' --password 'demo-password' \
  --device alice-send --room-default "$ROOM_ID"
mc /tmp/mc-bob --login password --homeserver http://localhost:8008 \
  --user-login '@bob:localhost' --password 'demo-password' \
  --device bob-listen --room-default "$ROOM_ID"
mc /tmp/mc-bob-send --login password --homeserver http://localhost:8008 \
  --user-login '@bob:localhost' --password 'demo-password' \
  --device bob-send --room-default "$ROOM_ID"
# F0: the demo room is invite-only (v11 genesis) and the stub enforces
# membership — invite + join the demo users through the engine pipeline
# (CS invite/join endpoints are M4 scope)
echo ">> seeding demo membership (invite + join alice, bob)"
docker exec "$CONTAINER" bash -c "cd /workspace && deno run --env --allow-net --allow-env --allow-read demo/seed-membership.ts '$ROOM_ID'"
# Warm-up sync: burn through the current backlog so each user's stored
# since-token points at "now". Without this, `--listen forever` at demo
# time replays every historical event across every prior test room on
# initial sync (our /sync is all-rooms, all-history — see the gap report).
# Also populates nio's client-side `self.rooms` cache so subsequent sends
# find the room without needing a fresh full-state sync.
echo ">> warm-up sync (all four stores)"
for d in /tmp/mc-alice /tmp/mc-alice-send /tmp/mc-bob /tmp/mc-bob-send; do
  mc "$d" --listen once --plain
done

# 7. summary
cat <<EOF

================================================================
communico demo is ready.
Room: $ROOM_ID   (a Doltgres database; every message is a commit)

Act 1 — real client sends (run on the host):
  docker run --rm --network container:$CONTAINER -v /tmp/mc-bob:/data:z -w /data \\
    $MC_IMAGE -m "real client, real commits" --room '$ROOM_ID' --plain \\
    --store /data/store --credentials /data/credentials.json

Act 2 — real client receives (two terminals):
  terminal 1 (alice listens):
    docker run --rm -it --network container:$CONTAINER -v /tmp/mc-alice:/data:z -w /data \\
      $MC_IMAGE --listen forever --plain \\
      --store /data/store --credentials /data/credentials.json
  terminal 2 (bob sends):
    docker run --rm --network container:$CONTAINER -v /tmp/mc-bob:/data:z -w /data \\
      $MC_IMAGE -m "hello alice via doltgres" --room '$ROOM_ID' --plain \\
      --store /data/store --credentials /data/credentials.json
Choreography helper:  bash demo/run-demo.sh            (interactive)
                      bash demo/run-demo.sh --check    (headless self-test)
                      bash demo/run-demo.sh --scripted (tmux, for asciinema)
================================================================
EOF
