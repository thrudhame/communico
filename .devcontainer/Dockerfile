# syntax=docker/dockerfile:1.3-labs
FROM denoland/deno:bin AS deno
FROM dolthub/doltgresql:latest as doltgres
FROM mcr.microsoft.com/vscode/devcontainers/base:trixie
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update
RUN apt-get upgrade -y

RUN apt-get install -y --no-install-recommends \
  tini

COPY --from=deno /deno /usr/local/bin/deno
RUN deno --version

COPY --from=doltgres /usr/local/bin/doltgres* /usr/local/bin/
RUN /usr/local/bin/doltgres --version

RUN mkdir -p /opt/doltgres/data && \
    chmod 755 /opt/doltgres/data && \
    mkdir -p /opt/doltgres/config && \
    chmod 755 /opt/doltgres/config && \
    chown -R vscode:vscode /opt/doltgres

VOLUME /opt/doltgres/

EXPOSE 5432
EXPOSE 8000

WORKDIR /workspace

USER vscode


