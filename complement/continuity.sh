#!/usr/bin/env bash
# complement/continuity.sh — F1 gate: a repeated container start keeps the
# same tenant key (signature continuity). Starts a scratch container from
# the Complement image, registers a user, sends an event, records the
# tenant pubkey + event signature; restarts the SAME container; asserts
# the pubkey is identical and the pre-restart signature still verifies.
# Usage: bash complement/continuity.sh (needs docker; VM-only per memo).
set -euo pipefail

NAME="${CONTINUITY_NAME:-cc-continuity}"
SERVER_NAME="${CONTINUITY_SERVER:-cont.local}"
IMAGE="${COMPLEMENT_IMAGE:-communico-complement:local}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo ">> starting $NAME ($SERVER_NAME)"
docker run -d --name "$NAME" -e SERVER_NAME="$SERVER_NAME" "$IMAGE" >/dev/null
echo ">> waiting for :8008 (90s budget)"
for i in $(seq 1 90); do
  if docker exec "$NAME" curl -sf localhost:8008/_matrix/client/versions >/dev/null 2>&1; then
    break
  fi
  [[ $i == 90 ]] && { echo "container never healthy" >&2; exit 1; }
  sleep 1
done

tenant_query() { # prints this tenant's pubkey (b64), via stdin-piped script
  docker exec -i -w /app/complement "$NAME" \
    deno run --allow-net --allow-env - < complement/continuity-query.ts 2>/dev/null | tail -1
}

echo ">> registering carol + creating room + sending event"
SES=$(docker exec "$NAME" curl -s -XPOST localhost:8008/_matrix/client/v3/register \
  -d '{"username":"carol","password":"pw"}' |
  python3 -c "import sys,json; print(json.load(sys.stdin)['session'])")
REG=$(docker exec "$NAME" curl -s -XPOST localhost:8008/_matrix/client/v3/register \
  -d "{\"username\":\"carol\",\"password\":\"pw\",\"auth\":{\"type\":\"m.login.dummy\",\"session\":\"$SES\"}}")
TOKEN=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
ROOM=$(docker exec "$NAME" curl -s -XPOST localhost:8008/_matrix/client/v3/createRoom \
  -H "Authorization: Bearer $TOKEN" -d '{"room_version":"11"}' |
  python3 -c "import sys,json; print(json.load(sys.stdin)['room_id'])")
EV=$(docker exec "$NAME" curl -s -XPUT \
  "localhost:8008/_matrix/client/v3/rooms/$ROOM/send/m.room.message/t1" \
  -H "Authorization: Bearer $TOKEN" -d '{"body":"continuity-probe","msgtype":"m.text"}' |
  python3 -c "import sys,json; print(json.load(sys.stdin)['event_id'])")
echo "   event: $EV"
K1=$(tenant_query)
echo "   pre-restart pubkey: ${K1:0:16}…"

echo ">> restarting the SAME container"
docker stop "$NAME" >/dev/null
docker start "$NAME" >/dev/null
echo ">> waiting for :8008 (90s budget)"
for i in $(seq 1 90); do
  if docker exec "$NAME" curl -sf localhost:8008/_matrix/client/versions >/dev/null 2>&1; then
    break
  fi
  [[ $i == 90 ]] && { echo "container never came back" >&2; exit 1; }
  sleep 1
done

K2=$(tenant_query)
echo "   post-restart pubkey: ${K2:0:16}…"
[[ "$K1" == "$K2" ]] || { echo "KEY ROTATED ACROSS RESTART" >&2; exit 1; }
echo "   key identical across restart ✓"

echo ">> verifying pre-restart event signature against post-restart key"
docker exec -i -w /app/complement -e C_ROOM="$ROOM" -e C_EVENT="$EV" -e C_PUB="$K2" "$NAME" \
  deno run --allow-net --allow-env - < complement/continuity-verify.ts 2>/dev/null | tail -1
echo "CONTINUITY: PASS"
docker rm -f "$NAME" >/dev/null
