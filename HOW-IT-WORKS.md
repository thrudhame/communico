# How communico works

One model, end to end: **rooms are version-controlled databases**.
Every Matrix event lands as a commit; forks are branches; heals are
merges. Identity is keypairs; the wire currency is content-hash event
ids, never store internals. Dolt does propagation, healing storage, and
certification; a per-version **rulebook** decides authorization and
state.

## 1. The room engine (`api/engine/`)

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
  `checkAuthChain` (rules 1-2 on the event's own auth_events),
  `checkAuthAgainstState` (rules 3-10 against a given state — reused by
  soft-fail and the iterative auth checks), `resolveState`, `redaction`.
  The rulebook is a pure TypeScript package (`api/engine/rulebook/`) with
  a per-version feature-flag record — every rule branches on a flag,
  never a version literal. Unknown room versions are rejected, never
  defaulted.
- **The real v11 rulebook (current).** All ten authorization rules,
  transcribed from spec v1.16 with one function per numbered rule; every
  verdict carries the rule number that decided it. Power levels are
  enforced (integers only per v10; creator 100 before the first
  power_levels event; defaults users -> users_default -> 0). Concurrent
  edits to one state key RESOLVE through state resolution v2: power
  events ordered by the reverse-topological power ordering, the rest by
  mainline order, iterative auth checks throughout — concurrent PL edits
  heal to the spec-determined winner. `latest-wins` is retired as an
  exploit; so is the refusing stub.
- **Three-stage ingest (S8).** Every event is checked (a) against its
  own auth_events, (b) against the state at its prevs (fail -> rejected,
  flagged, out of state), and (c) against the current room state — a
  failure there is a SOFT-FAIL: stored verbatim, not an extremity for
  authoring, excluded from the client-visible timeline.
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

## 2. Identity, account surface, media (`db/tenant/`, `api/engine/{tenant,uia,media}.ts`)

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
- `/register` is real UIA (dummy + password stages, persisted sessions;
  bodies validated before UIA: spec localpart grammar + downcasing,
  `M_USER_IN_USE`, `inhibit_login`, `device_id`,
  `/register/available`). `/login` verifies argon2id (403
  `M_FORBIDDEN`, 403 `M_USER_DEACTIVATED` after deactivation) and
  honors `device_id`/`initial_device_display_name`; `/logout` removes
  token + device, `/logout/all` removes them user-wide. Tokens are
  bearer credentials in the tenant DB; unknown/missing tokens are
  proper 401s. Dev seeds register through this same path.
- **M2 account surface** — all UIA goes through one shared helper
  (`api/engine/uia.ts`): session or one-shot, a caller/identifier
  mismatch 403s BEFORE any password verification, a wrong password is
  a 401 `M_FORBIDDEN` carrying the UIA keys. On top of it: devices
  (get/list/rename, delete via password UIA — a bodyless DELETE is the
  spec's first UIA step, not a parse fault), profiles (public read,
  self-only write, foreign mxc avatar URLs stored verbatim), password
  change (`logout_devices` default true — other tokens AND their
  pushers die; the caller's token is kept) and deactivation. Pushers
  are stored, never delivered — `data.url` is never fetched. Account
  data (global + per-room) writes/reads the BARE content object;
  missing reads are 404 `M_NOT_FOUND`.
- **Media (M2)** — bytes on disk under `MEDIA_ROOT` (a required env
  var, like `MEDIA_MAX_BYTES`; nine total), metadata in the tenant
  `media` table. Uploads stream through a counting writer to
  `<id>.part` — over the limit aborts, deletes the part, and answers
  413 `M_TOO_LARGE`; success renames to the final path. Async flow:
  `POST /media/v1/create` mints a pending id (`unused_expires_at` =
  created + 24 h), `PUT /media/v3/upload/{server}/{id}` fills it (409
  `M_CANNOT_OVERWRITE_MEDIA` on a second PUT, 403 across users).
  Downloads: the authenticated `client/v1` route (401 before any
  lookup) and the legacy unauthenticated one (spec-deprecated — frozen
  at a later milestone). Served headers per spec v1.16: stored
  `Content-Type` verbatim, `Content-Disposition` computed from the
  stored type (26-entry inline allow-list, else `attachment`; RFC 6266
  filename), the recommended CSP, `Cross-Origin-Resource-Policy:
  cross-origin`. mxc components are whitelist-checked
  (`^[A-Za-z0-9_-]+$`) before any lookup — never touch the filesystem
  with an unvalidated id. No thumbnails, previews, remote fetch, or
  retention in M2.

## 3. Sync (parked)

The browser homeserver (communico-lite) and the native sync protocols
(msync/dsync) are parked — prior art on `research/lite`, plan in
`~/Documents/communico/plans/lite/`. The server-side pieces that existed
only for them (the msync peer, the ws endpoint, the engine facade) left
with this cleanup; the server speaks the Matrix client-server API only.

## 4. Conformance (`complement/`)

Complement is the compass, not the target: one image (Doltgres +
communico, `tini`), `:8008` plain HTTP + `:8448` TLS (cert signed by
Complement's mounted CA, 404 for every path — federation is M5),
`SERVER_NAME` from env, self-managed storage, idempotent inits. The
**blacklist** has two sections — principled/permanent (3PID issuance,
history surgery, `/_synapse/*`, unstable MSCs) and scheduled (E2EE,
push, federation/M5, room endpoints over the rulebook/M4,
rate limits/M2) — applied as
build tags from the human file; case-level exclusions are triaged in
`BASELINE.md`, never blacklisted (`30rooms`, `31sync`, redaction,
`50federation`). `continuity.sh` proves the tenant key survives
container restarts.

## 5. What's stubbed (roadmap)

Room version 12 registration behind the same rulebook slot (after M4 —
the rulebook already carries its switches); room endpoints over the
rulebook (`/join`, `/leave`, `/invite`, `/ban`, `/kick`, `PUT /state`,
membership-aware `/sync` — M4); S2S federation (M5); relay `bind/forward`;
E2EE; push delivery/rules (M2's pushers are storage-only);
appservices; rate limiting; media thumbnails, URL previews, remote
fetch, and retention (M2 is local store-and-serve only);
`/_matrix/key/*` and `.well-known`; at-rest encryption of tenant
private keys. Stub-era rooms are flagged and will never federate.

## 6. Verification

Each phase gates green before the next begins: `deno task check` +
`deno task test`, `demo/setup.sh --reset && demo/run-demo.sh --check`,
a Complement number that moves, and container-restart key continuity.
All runs happen on the ark VM fleet (never the laptop). Evidence per
phase lives in `~/Documents/communico/research/RESULTS.md`; the plan of
record lives outside the repo.
