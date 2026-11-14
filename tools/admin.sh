#!/bin/sh
# Resolve the same configuration as the server, then grant only its Unix socket.
set -eu
tool=$1
shift
case "$tool" in
  federation-block|federation-peer|federation-key|federation-outbox|federation-cert|rooms|backup) ;;
  *) exit 2 ;;
esac
socket=$(deno run --env --allow-env --allow-read tools/admin-client.ts --socket)
exec deno run --env --allow-env --allow-read "--allow-write=$socket" \
  "--allow-net=unix:$socket" "tools/$tool.ts" "$@"
