# How communico works

One model, end to end: **rooms are version-controlled databases**.
Every Matrix event lands as a commit; forks are branches; heals are
merges. Identity is keypairs; the wire currency is content-hash event
ids, never store internals. Dolt does propagation, healing storage, and
certification; a per-version **rulebook** decides authorization and
state; thin adapters ("hats") project rooms onto transports.

## 1. The room engine (`api/engine/`, `lite/web/engine-lite.js`)

- **PDU in, PDU stored.** Ingest takes a full room-v11 PDU
  (`type/room_id/sender/content/state_key?`, ≤20 `prev_events`,
  `auth_events`, real `depth` with genesis = 1, `origin_server_ts`,
  `hashes{sha256}`, `signatures`, `unsigned?`) and stores it **verbatim**
  as canonical-JSON text plus indexed columns. `event_id` is derived —
  `$` + unpadded-base64url(SHA-256(canonical-JSON(redacted PDU))) —
  never stored as input, always recomputed on receipt (self-certifying).
- **Identity layer per version.** `eventIdFor(pdu, roomVersion)` and
  `redact(pdu, roomVersion)` implement v11's redaction table transcribed
  from the spec (notably: power-levels keeps everything *except*
  `notifications`; `origin` is stripped; `redacts` lives under content).
  Canonical JSON enforces the integer range, so a `ts=2^53` seizure is
  refused at the door.
- **Signing order** (spec): content hash → redact → sign. The server
  signs with the tenant key; browsers sign with their homeserver key.
  Verification is verify-if-present against the named key, or key-is-name
  for base32 server names (the name IS the ed25519 key — nothing to
  fetch). Unsigned PDUs are refused, full stop.
- **The policy slot.** The core dispatches to the room version's
  rulebook and never implements version logic: `selectAuthEvents`,
  `authorized` (`ok | authchain-reject | state-reject | soft-fail`),
  `resolveState`, `redaction`. One shared stub source
  (`lite/web/sync/rulebook/v11-stub.js`) is consumed byte-identically by
  both engines. Unknown room versions are rejected, never defaulted.
- **The refusing stub (current).** Membership only — no timestamps, no
  power levels (declared gap, M3). The room creator's first join is
  exempt. Concurrent edits to one state key throw
  `M_UNRESOLVED_CONFLICT`: the room stays forked, the heal is refused,
  nothing is guessed. `latest-wins` is retired as an exploit.
- **State is the resolver's cache.** One invariant: *no path writes
  `state` except the resolver* — ingest, heal, and adoption funnel
  through a single `materialize()` per engine (the gate greps it).
  Rejected events stay in the DAG, flagged, out of state. N-prev fan-in
  chains 2-parent commits (bookkeeping); the event DAG keeps all N.
- **Convergence gossip.** The announce carries `th = {engine, events,
  state, sh, room_version}` where `sh` is the digest of the announced
  frontier's resolved state over event ids. Contested keys yield an
  *absent* `sh`, never a different one.
- **Adoption re-resolves.** Store images are validated event-by-event
  (id, content hash, signature, version) and then *replayed* from the
  DAG — image `state` tables are never trusted (forged rows dropped);
  a conflict adopts the DAG, holds pre-adoption state, and returns the
  refusal instead of throwing.

## 2. Identity and registration (`db/tenant/`, `api/engine/tenant.ts`)

- A **tenant** = one identity DB + its room DBs + hat config
  (`tenant_<sha(SERVER_NAME)>`; N = 1 today, and no code cares).
  The tenant holds the ed25519 signing keypair — generated once, reused
  forever, migrated from the F0 dev key, never rotated. Its base32 form
  (52 lowercase chars, one DNS label) is the native `server_name`;
  the DNS `SERVER_NAME` rides beside it for the legacy hat.
- Hosted users are **localparts under the tenant key**
  (`@alice:<server>`) — custodial, as in Matrix. Passwords are
  **argon2id PHC strings** (OWASP defaults m=19456/t=2/p=1, ~29 ms;
  algorithm+params+salt in-band). No unsalted SHA-256 anywhere.
- `/register` is real UIA (dummy + password stages, persisted
  sessions — required, never one-shot; bodies validated before UIA:
  spec localpart grammar + downcasing, `M_USER_IN_USE`,
  `inhibit_login`, `device_id`, `/register/available`). `/login`
  verifies argon2id (403 `M_FORBIDDEN`); `/logout` removes token +
  device, `/logout/all` removes them user-wide; `/devices` lists them.
  Tokens are bearer credentials in the tenant DB; unknown/missing
  tokens are proper 401s. Dev seeds register through this same path.
- The **browser is a homeserver too**: one keypair per browser
  (persisted), N concurrent **personas** (`@alice:<lite-b32>`,
  `@bob:<lite-b32>`, localpart fixed at creation, `displayname`
  renames), rooms belong to a profile, everything signed, key
  export/import moves all profiles at once.

## 3. Sync (`lite/web/sync/`, `api/hats/lite/`)

- **msync** — the event-level floor every pair speaks: tips gossip,
  delta-request, topologically sorted deltas; refused-but-stored events
  still render and gossip (refusal is materialization, never a
  propagation drop); held events retry ≤3 rounds.
- **dsync** — the same-engine fast path: store images over the
  transport, fetch, mechanical merge, replay + materialize.
- **The lite hat** lets browsers join server rooms over WebSocket
  (`?transport=ws&sync=msync`): the server runs an msync peer per room
  over its engine facade. Same events, same ids, both sides.

## 4. Conformance (`complement/`)

Complement is the compass, not the target: one image (Doltgres +
communico, `tini`), `:8008` plain HTTP + `:8448` TLS (cert signed by
Complement's mounted CA, 404 for every path — federation is M5),
`SERVER_NAME` from env, self-managed storage, idempotent inits. The
**blacklist** has two sections — principled/permanent (3PID issuance,
history surgery, `/_synapse/*`, unstable MSCs) and scheduled (E2EE,
push, federation/M5, resolution + auth/M3, rate limits/M2) — applied as
build tags from the human file; case-level exclusions are triaged in
`BASELINE.md`, never blacklisted (`30rooms`, `31sync`, redaction,
`50federation`). `continuity.sh` proves the tenant key survives
container restarts.

## 5. What's stubbed (roadmap)

Real v11/v12 resolution behind the same policy slot (M3, incl.
power-level auth); S2S federation (M5); pathfinder (M1); relay
`bind/forward`; E2EE/appservices/push/rate limiting; `/_matrix/key/*`
and `.well-known`; at-rest encryption of tenant private keys; OPFS
persistence for browser stores. Stub-era rooms are flagged and will
never federate.

## 6. Verification

Each phase gates green before the next begins: `deno task check` +
`deno task test`, the 8 lite checks + fork-refusal + adoption checks,
`demo/setup.sh --reset && demo/run-demo.sh --check`, a Complement
number that moves, and container-restart key continuity. All runs
happen on the ark VM fleet (never the laptop). Evidence per phase in
`spikes/RESULTS.md`; the plan of record lives outside the repo.
