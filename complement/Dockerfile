# syntax=docker/dockerfile:1.3-labs
# complement/Dockerfile — M0 Complement harness image (Doltgres + communico).
# Meets Complement's image contract: 8008 (plain HTTP) + 8448 (TLS, cert
# signed by Complement's mounted CA at container start), 200 on
# GET /_matrix/client/versions, SERVER_NAME from env, self-managed storage,
# idempotent across repeated CMD.
FROM denoland/deno:bin AS deno
FROM dolthub/doltgresql:latest AS doltgres
FROM mcr.microsoft.com/vscode/devcontainers/base:trixie
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  tini openssl curl ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deno /deno /usr/local/bin/deno
COPY --from=doltgres /usr/local/bin/doltgres* /usr/local/bin/
RUN /usr/local/bin/doltgres --version && /usr/local/bin/deno --version

RUN mkdir -p /opt/doltgres/data /opt/doltgres/config /run/complement \
  && chmod 755 /opt/doltgres/data /opt/doltgres/config

WORKDIR /app
COPY doltgres/config /etc/doltgres/servercfg.d
COPY deno.json deno.lock main.ts setup.ts ./
COPY api ./api
COPY db ./db
COPY complement ./complement
RUN chmod +x /app/complement/entrypoint.sh
# cache remote deps at build time (no network needed at container start)
# The image's env contract (ruling 8 — infra keeps its numbers): the app
# reads every variable from the environment; Complement overrides SERVER_NAME
# per deployment at container start.
ENV APP_PORT=8008 SERVER_NAME=localhost DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=root DB_PASS=secret DB_NAME=postgres MEDIA_ROOT=/data/media MEDIA_MAX_BYTES=52428800
RUN mkdir -p /data/media
RUN deno cache main.ts db/init.ts complement/tls-stub.ts

EXPOSE 8008 8448
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=5 \
  CMD curl -sf http://localhost:8008/_matrix/client/versions || exit 1
ENTRYPOINT ["tini", "--", "/app/complement/entrypoint.sh"]
