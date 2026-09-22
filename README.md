# communico

I communicate — a Matrix homeserver where the database is
version-controlled: **a room is a Doltgres database, an event is a
commit, forward extremities are branches**, and the event id clients see
is a content hash of the event itself.

Active line: `server-foundation` — engine contract (F0) → Complement
harness (M0) → identity + registration (F1) → HTTP layer on pathfinder
(M1) → account surface + media (M2). See `HOW-IT-WORKS.md` for the
architecture; the evidence log lives in
`~/Documents/communico/research/RESULTS.md`.

## Quickstart (demo)

Prerequisites: Docker only. Runs on the shipped `defaults/communico.toml`.
To change something, create `config/communico.toml` with just the leaves
you want, or set `COMMUNICO_*` (see `.env.example` for the env syntax).

```bash
bash demo/setup.sh --reset   # boots Doltgres+server, registers users, creates the room
bash demo/run-demo.sh --check  # headless self-test: two real matrix-commander clients
```

Details and choreography: `demo/README.md`.

## Conformance

```bash
bash complement/run.sh            # full Complement baseline → complement/BASELINE.md
bash complement/run.sh -run 'TestRegistration|TestLogin|TestLogout'
```

Image contract, blacklist philosophy, and the red number to beat:
`complement/blacklist.md`. Key continuity across restarts:
`bash complement/continuity.sh`.

## Repo map

- `api/engine/` — room core: PDU ingest, per-version policy slot,
  tenant identity, sync feeds. `state` is written only by the resolver.
- `api/endpoints/matrix/` — Client-Server surface (register, login,
  rooms, sync, devices, profiles, account, pushers, account data,
  media, …).
- `db/` — `server/` (room registry, event index), `room/` (per-room
  schema), `tenant/` (per-tenant identity schema).
- `complement/` — Docker image, entrypoint, blacklist, runner, baseline.
- `demo/` — three-party demo scripts and tour.

## Status and roadmap

Done: v11 PDU engine with refusing stub resolver, Complement harness
with red baseline, tenant identity (argon2id UIA registration), the
HTTP layer on pathfinder 0.2.0 (M1) — two roots collapsed to the single
Matrix client-server listener on `server.port` — and the M2 account
surface + media: devices, profiles, password change and deactivation
over a shared UIA helper, pushers (stored, never delivered), account
data, and the content repository (upload, async create/PUT,
authenticated + legacy download, config; bytes on disk under
`media.root`, metadata in the tenant DB). Deliberately stubbed: real
state resolution (M3), server-to-server federation (M5, `:8448` serves
TLS + 404 today), E2EE, push delivery/rules, appservices, rate
limiting, media thumbnails/previews/remote fetch/retention. The legacy
unauthenticated media download is a documented liability — frozen at a
later milestone. The browser homeserver (communico-lite) and native
sync are parked — prior art on `research/lite`, plan in
`~/Documents/communico/plans/lite/`. Pushes are user-gated.
