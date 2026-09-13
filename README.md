# communico

I communicate — a Matrix homeserver where the database is
version-controlled: **a room is a Doltgres database, an event is a
commit, forward extremities are branches**, and the event id clients see
is a content hash of the event itself.

Active line: `server-foundation` — engine contract (F0) → Complement
harness (M0) → identity + registration (F1) → HTTP layer on pathfinder
(M1). See `HOW-IT-WORKS.md` for the architecture; the evidence log lives
in `~/Documents/communico/research/RESULTS.md`.

## Quickstart (demo)

Prerequisites: Docker only. First run: `cp .env.example .env` (the real
environment wins over that file; container images take theirs from ENV).

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
- `api/endpoints/_matrix/` — Client-Server surface (register, login,
  rooms, sync, …).
- `db/` — `server/` (room registry, event index), `room/` (per-room
  schema), `tenant/` (per-tenant identity schema).
- `complement/` — Docker image, entrypoint, blacklist, runner, baseline.
- `demo/` — three-party demo scripts and tour.
- `spikes/` — engineering notes and the phase-by-phase evidence log.

## Status and roadmap

Done: v11 PDU engine with refusing stub resolver, Complement harness
with red baseline, tenant identity (argon2id UIA registration),
browser homeservers with personas. Deliberately stubbed: real state
resolution (M3), server-to-server federation (M5, `:8448` serves TLS +
404 today), E2EE/push/appservices/rate limiting. No merge back to the
spike line without explicit agreement; pushes are user-gated.

