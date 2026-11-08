# syntax=docker/dockerfile:1.3-labs
# Complement image contract: HTTP :8008, TLS :8448 with the mounted CA,
# SERVER_NAME from the harness, and storage reused across repeated CMD.
FROM denoland/deno:bin-2.9.7 AS deno
FROM mcr.microsoft.com/vscode/devcontainers/base:trixie
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  tini openssl curl ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deno /deno /usr/local/bin/deno
RUN /usr/local/bin/deno --version

WORKDIR /app
COPY deno.json deno.lock main.ts ./
COPY api ./api
COPY defaults ./defaults
COPY complement ./complement
# Build with `deno task native` in the project VM before docker build.
# openStore validates ffi_build_info against #engine/store/build.ts.
COPY .native/libturso_ffi.so ./.native/libturso_ffi.so
RUN chmod +x /app/complement/entrypoint.sh \
  && mkdir -p /app/config /app/.store /app/.media /app/.tmp /run/complement
ENV COMMUNICO_STORE_DIR=/app/.store
ENV COMMUNICO_MEDIA_ROOT=/app/.media
ENV TMPDIR=/app/.tmp
ENV COMMUNICO_FEDERATION_CERT=/run/complement/server.crt
ENV COMMUNICO_FEDERATION_KEY=/run/complement/server.key
ENV COMMUNICO_PREVIEW_ENABLED=true
RUN deno cache main.ts

EXPOSE 8008 8448
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=5 \
  CMD curl -sf http://localhost:8008/_matrix/client/versions || exit 1
ENTRYPOINT ["tini", "--", "/app/complement/entrypoint.sh"]
