#!/usr/bin/env bash
# complement/entrypoint.sh — Complement image entrypoint (PID 1 is tini).
# tini → doltgres (storage inside the image) → wait :5432 → `db-init`
# (idempotent: keypair reused, tenant DB reused) → communico :8008 +
# TLS :8448 stub. Tolerates repeated CMD (everything is idempotent;
# doltgres reuses its data dir, the cert is reissued, inits are no-ops).
set -euo pipefail

SERVER_NAME="${SERVER_NAME:-localhost}"
APP_DIR="/app"

echo ">> entrypoint: SERVER_NAME=$SERVER_NAME"

# 1. doltgres (background; storage inside the image — same shape as the
# dev container: config file + DOLTGRES_* env, data under /opt/doltgres)
if ! pgrep -x doltgres >/dev/null 2>&1; then
  echo ">> starting doltgres"
  export DOLTGRES_USER="${DOLTGRES_USER:-root}" DOLTGRES_PASSWORD="${DOLTGRES_PASSWORD:-secret}" DOLTGRES_DB="${DOLTGRES_DB:-postgres}"
  doltgres --config /etc/doltgres/servercfg.d/config.yaml > /tmp/doltgres.log 2>&1 &
fi
echo ">> waiting for doltgres :5432 (60s budget)"
for i in $(seq 1 60); do
  if timeout 1 bash -c '</dev/tcp/127.0.0.1/5432' 2>/dev/null; then
    break
  fi
  [[ $i == 60 ]] && { echo "doltgres did not come up" >&2; exit 1; }
  sleep 1
done

# 2. provision (idempotent: schema IF NOT EXISTS, signing key reused).
# Direct `deno run` (not `deno task`, whose --env flag wants a .env file):
# the container environment is the whole config here.
echo ">> db-init"
cd "$APP_DIR"
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=root DB_PASS=secret DB_NAME=postgres
deno run --allow-net --allow-env --allow-read db/init.ts

CERT_DIR="/run/complement"
mkdir -p "$CERT_DIR"

# 3. :8448 TLS cert — the Complement README's exact recipe against the
# mounted CA (/complement/ca/ca.{crt,key}); self-signed when running
# outside Complement (local dev).
if [[ -f /complement/ca/ca.crt && -f /complement/ca/ca.key ]]; then
  echo ">> issuing :8448 cert from the mounted Complement CA"
  openssl genrsa -out "$CERT_DIR/server.key" 2048 2>/dev/null
  openssl req -new -sha256 -key "$CERT_DIR/server.key" \
    -subj "/C=US/ST=CA/O=Complement/CN=$SERVER_NAME" \
    -out "$CERT_DIR/server.csr" 2>/dev/null
  openssl x509 -req -in "$CERT_DIR/server.csr" \
    -CA /complement/ca/ca.crt -CAkey /complement/ca/ca.key -CAcreateserial \
    -out "$CERT_DIR/server.crt" -days 2 -sha256 2>/dev/null
else
  echo ">> no Complement CA mounted — self-signed :8448 cert (dev only)"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" -days 2 \
    -subj "/CN=$SERVER_NAME" 2>/dev/null
fi

# 4. :8448 TLS stub (background) + communico :8008 (foreground).
# The F0 unsigned-lite seam stays OFF here (ALLOW_UNSIGNED_LITE unset).
echo ">> starting :8448 TLS stub"
TLS_CERT_FILE="$CERT_DIR/server.crt" TLS_KEY_FILE="$CERT_DIR/server.key" \
  deno run --allow-net --allow-read --allow-env "$APP_DIR/complement/tls-stub.ts" \
  > /tmp/tls-stub.log 2>&1 &
echo ">> starting communico :8008"
export APP_A_PORT=8008 SERVER_NAME DB_HOST DB_PORT DB_USER DB_PASS DB_NAME
exec deno run --allow-net --allow-env --allow-read "$APP_DIR/main.ts"
