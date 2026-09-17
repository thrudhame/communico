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
  from the spec (notably: power-levels keeps everything _except_
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
- **State is the resolver's cache.** One invariant: _no path writes
  `state` except the resolver_ — ingest, heal, and adoption funnel
  through a single `materialize()` per engine (the gate greps it).
  Rejected events stay in the DAG, flagged, out of state. N-prev fan-in
  chains 2-parent commits (bookkeeping); the event DAG keeps all N.
- **Current state lives on `main`.** Every `x*` branch is one event's
  history and carries the state _at that event_ (resolver input via
  `AS OF`); it is never committed to again (D8: branch tip == event
  commit, always). Whenever the extremity set changes, the resolver's
  output across the set is republished on `main` — readers of current
  state read `main`, nothing else.
- **State at any point is `main`'s history (E1).** Every ingest records
  `HASHOF('main')` right after its publish as the event's
  `state_commit_hash`; "state at seq N in room R" is `state AS OF` the
  hash of the last non-rejected R-event with seq ≤ N. One primitive
  serves `/members?at=`, `invite_state`, `unsigned.membership`, the
  `state` blocks in `/sync`, and left users reading as-of-leave.
- **Membership has a server-side index (E2).**
  `room_membership(room_id, user_id, membership, event_id, seq)` is a
  derived cache of `main`, written in the same ingest step — per-user
  room lists without scanning room DBs.
- **Sync tokens are two-stream (E3).** `s<eventSeq>_p<presenceSeq>`
  (legacy `s<n>` parses as `_p0`) — global stream positions, valid
  across users and as `/messages?from=`/`/members?at=`.
- **Extremities follow Synapse's rule (E4).** Rejected and soft-failed
  events neither become extremities nor consume their prevs; an
  accepted event citing one consumes its branch and walks back through
  flagged ancestors (`persist_events.py:1052-1111`).
- **Ingest is per-room serialized (E5).** An in-process async lock
  keyed by room id wraps prev resolution through the `main` publish —
  parallel subtests on one room can't race the publish.
- **Convergence gossip.** The announce carries `th = {engine, events,
  state, sh, room_version}` where `sh` is the digest of the announced
  frontier's resolved state over event ids. Contested keys yield an
  _absent_ `sh`, never a different one.
- **Adoption re-resolves.** Store images are validated event-by-event
  (id, content hash, signature, version) and then _replayed_ from the
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

## 3. Rooms and sync (M4)

- **Membership goes through the rulebook.** join/leave/invite/ban/kick
  author `m.room.member` with the right sender/state_key/content and
  ingest it; rulebook rejects are 403 `M_FORBIDDEN`. Idempotent
  re-join (already joined → the existing event, no new one), invite
  target validation (self/already-joined 403, malformed 400), and the
  kick pre-check (target must be join/invite/knock — the spec's auth
  rules carry no target-membership condition, so it is an op-layer
  check, as in Synapse's REST handler). Endpoints:
  `/join/:idOrAlias` (alias → `room_aliases`, body keys merge into
  member content) and `/rooms/:id/{join,leave,invite,ban,kick}`.
- **State is read and written per key.**
  `GET/PUT /rooms/:id/state/:type/:stateKey` (the trailing-slash form
  is the empty state key), whole-room `GET /state` (full client events
  from `main`), `/members` (`?at=`, membership filters),
  `/joined_members`, `/joined_rooms`. PUT is idempotent for identical
  content + same sender. Left users read as-of-leave; non-members 403.
- **`createRoom` speaks the spec's options** (create_room.yaml at
  v1.16): presets; spec-default power levels written out in full and
  deep-merged with `power_level_content_override`; `initial_state`
  before `name`/`topic` (they override it); the `invite` list;
  `room_alias_name` (409 on conflict) + canonical alias;
  `creation_content` minus `room_version`; the rich `m.topic` form.
- **Transactions are idempotent per (device, room, txn)** — a repeat
  send returns the recorded event id regardless of content;
  `unsigned.transaction_id` renders for the sending device only.
- **Redactions are applied at read.** `/redact` checks authorization
  (own event, or ≥ the `redact` level), authors `m.room.redaction`,
  and marks the index row; the stored PDU stays verbatim — the client
  formatter applies the room version's keep-table and attaches
  `unsigned.redacted_because`.
- **History visibility is evaluated at the event** (E1 state): the
  module's rules with `history_visibility` at the event and the
  viewer's membership there; own membership events always visible.
  Not visible → 404 on `/event`, filtered from `/messages` and
  `/sync` timelines. Left users are clamped to their leave.
- **`/sync` is per-user** with join/invite/leave sections, filters
  (stored + inline; types, limits, lazy members, include_leave),
  `limited`/`prev_batch` windows (`prev_batch` = `s<firstReturned-1>`
  only when the timeline was trimmed to the limit, else the window
  end — Synapse's rule), state deltas at the timeline start, invite
  stripped state, summary counts/heroes, presence fan-out (its own
  stream), device_lists, and `unsigned.membership` per event. `r0`
  re-exports `joined_members` and `messages`.

## 4. Sync (parked)

The browser homeserver (communico-lite) and the native sync protocols
(msync/dsync) are parked — prior art on `research/lite`, plan in
`~/Documents/communico/plans/lite/`. The server-side pieces that existed
only for them (the msync peer, the ws endpoint, the engine facade) left
with this cleanup; the server speaks the Matrix client-server API only.

## 5. Conformance (`complement/`)

Complement is the compass, not the target: one image (Doltgres +
communico, `tini`), `:8008` plain HTTP + `:8448` TLS (cert signed by
Complement's mounted CA, 404 for every path — federation is M5),
`SERVER_NAME` from env, self-managed storage, idempotent inits. The
**blacklist** has two sections — principled/permanent (3PID issuance,
history surgery, `/_synapse/*`, unstable MSCs) and scheduled (E2EE,
push, federation/M5, rate limits/M2) — applied as
build tags from the human file; case-level exclusions are triaged in
`BASELINE.md`, never blacklisted (`30rooms`, `31sync`, redaction,
`50federation`). `continuity.sh` proves the tenant key survives
container restarts.

## 6. What's stubbed (roadmap)

Room version 12 registration behind the same rulebook slot (the
rulebook already carries its switches); band C (typing, receipts,
room directory/aliases/publicRooms, forget, relations/threads,
search/upgrade, user_directory, profile→member propagation, ignored
users, url_preview); S2S federation (M5); relay `bind/forward`;
E2EE; push delivery/rules (M2's pushers are storage-only);
appservices; rate limiting; media thumbnails, URL previews, remote
fetch, and retention (M2 is local store-and-serve only);
`/_matrix/key/*` and `.well-known`; at-rest encryption of tenant
private keys. Stub-era rooms are flagged and will never federate.

## 7. Verification

Each phase gates green before the next begins: `deno task check` +
`deno task test`, `demo/setup.sh --reset && demo/run-demo.sh --check`,
a Complement number that moves, and container-restart key continuity.
All runs happen on the ark VM fleet (never the laptop). Evidence per
phase lives in `~/Documents/communico/research/RESULTS.md`; the plan of
record lives outside the repo.
