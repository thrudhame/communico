#!/usr/bin/env bash
# Complement owns SERVER_NAME and the mounted CA. main.ts provisions the
# Turso store and tenant identity idempotently, including on repeated CMD.
set -euo pipefail

APP_DIR="/app"
export COMMUNICO_SERVER_NAME="$SERVER_NAME"
echo ">> entrypoint: SERVER_NAME=$SERVER_NAME"
cd "$APP_DIR"

CERT_DIR="/run/complement"
mkdir -p "$CERT_DIR"

# Complement's certificate recipe; self-signed for standalone image smoke.
if [[ -f /complement/ca/ca.crt && -f /complement/ca/ca.key ]]; then
  echo ">> issuing :8448 cert from the mounted Complement CA"
  openssl genrsa -out "$CERT_DIR/server.key" 2048 2>/dev/null
  openssl req -new -sha256 -key "$CERT_DIR/server.key" \
    -subj "/C=US/ST=CA/O=Complement/CN=$SERVER_NAME" \
    -out "$CERT_DIR/server.csr" 2>/dev/null
  openssl x509 -req -in "$CERT_DIR/server.csr" \
    -CA /complement/ca/ca.crt -CAkey /complement/ca/ca.key -CAcreateserial \
    -extfile <(printf 'subjectAltName=DNS:%s' "$SERVER_NAME") \
    -out "$CERT_DIR/server.crt" -days 2 -sha256 2>/dev/null
else
  echo ">> no Complement CA mounted - self-signed :8448 cert (dev only)"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" -days 2 \
    -subj "/CN=$SERVER_NAME" \
    -addext "subjectAltName=DNS:$SERVER_NAME" 2>/dev/null
fi

echo ">> exporting federation config"
export COMMUNICO_FEDERATION_CERT="/run/complement/server.crt"
export COMMUNICO_FEDERATION_KEY="/run/complement/server.key"
if [[ -f /complement/ca/ca.crt ]]; then
  export COMMUNICO_FEDERATION_CACERTS="/complement/ca/ca.crt"
fi
echo ">> starting communico :8008"
exec deno run --allow-net --allow-env --allow-read --allow-write --allow-ffi --allow-sys=uid,umask,ca --allow-run=openssl "$APP_DIR/main.ts"
