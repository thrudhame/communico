# endpoints-capture.md — matrix-commander (matrix-nio) traffic into communico

Client: `matrixcommander/matrix-commander` Docker image (latest @
sha256:610f6867…), matrix-commander with **matrix-nio 0.25.2**, invoked
per the phase-0 commands (minus `-it` — no TTY in the executor shell;
recorded deviation, no behavioral impact: the flows are non-interactive
in batch mode).

Capture sources used (phase-0 §"Capture sources"):
1. **Server console** (app log `METHOD URL - Nms` lines) — used; captures
   in `raw-server.log`.
2. **Client `--debug --verbose --verbose` logs** — used; `raw-login.log`,
   `raw-listen.log`, `raw-tail.log`.
3. **http-debug-proxy** — SKIPPED at this stage: sources 1+2 plus source
   inspection answered all five conclusions for the login flow; the send/
   listen/tail flows fail client-side before any HTTP (no credentials
   file — login 404s), so there was no wire traffic to proxy. Phase-0
   step 0.1 sanctions this: send/listen/tail are **re-run after Phase 1**
   (once login works) and the table below is updated from that wire
   capture. Proxy remains available if the re-run leaves body shapes
   unclear.
4. **Client source inspection** (corroborating; the client is the data):
   matrix_commander.py and nio/api.py were read inside the image to
   establish the flows' full request set, since the wire capture alone
   stops at the first 404. Rows below are marked **[wire]** (observed on
   the wire here) vs **[source]** (read from client source, to be
   wire-confirmed in the post-Phase-1 re-run).

## Request table

| # | Method | Path (exact) | Query params | Auth mechanism | Body shape (keys) | Client expects back | Evidence |
|---|--------|--------------|--------------|----------------|-------------------|---------------------|----------|
| 1 | GET | `/_matrix/client/r0/login` | — | none | — | `{flows:[{type:…}]}` containing `m.login.password` | **[wire]** 404 observed both sides |
| 2 | POST | `/_matrix/client/v3/login` | — | none | `type`='m.login.password', `identifier`:{`type`='m.id.user', `user`}, `password`, `device_name` (optional `device_id`) | `user_id`, `access_token`, `device_id` (+ optional `home_server`) | **[source]** nio `Api.login` (v3 default) + LoginResponse fields |
| 3 | GET | `/_matrix/client/v3/sync` | `access_token`, `timeout`, `full_state`; `since` when continuing; (`filter`/`set_presence` only if configured — not set by these flows) | **`?access_token=` query param** | — | `next_batch`; `rooms.join.<id>.timeline.events[]` etc. (Phase 2 minimums validated by re-run) | **[source]** nio `Api.sync`; matrix-commander startup `sync(timeout=10000, full_state=True)`; listen loop `sync(timeout=…, full_state=False)` with persisted `since` (store_sync_tokens=True) |
| 4 | PUT | `/_matrix/client/v3/rooms/<roomId>/send/<type>/<txnId>` | `access_token` | query param | `{msgtype:'m.text', body:…}` (plain text) | `event_id` | **[source]** nio `Api.room_send` (v3 default) |
| 5 | GET | `/_matrix/client/v3/rooms/<roomId>/messages` | `access_token`, `limit`, `dir` ('b'), optional `from`/`to`, optional `filter` | query param | — | `chunk[]`, `start`/`end` tokens | **[source]** nio `Api.room_messages` (used by `--tail`) |
| 6 | POST | `/_matrix/client/v3/keys/upload` | `access_token` | query param | `device_keys{…}`, `one_time_keys{…}` | `one_time_key_counts{}` | **[source]** nio auto-uploads device keys on first sync when encryption_enabled=True (matrix-commander hardcodes it) AND a store exists (`--store` passed) |
| 7 | POST | `/_matrix/client/v3/keys/query` | `access_token` | query param | `device_keys`:{user:[]}, optional `token` | `device_keys{}`, `failures{}` | **[source]** possible in encrypted-room paths; with `--plain` + unencrypted rooms expected to be at most login-time noise |
| 8 | GET | `/_matrix/client/v3/account/whoami` | `access_token` | query param | — | `user_id` | **[source]** present in nio; not invoked by these four flows |
| 9 | GET | `/_matrix/client/v3/joined_rooms` | `access_token` | query param | — | `joined_rooms[]` | **[source]** present in nio; not invoked by these four flows |

## Conclusions

1. **r0 or v3?** BOTH — and the split is precise: matrix-commander's own
   login code (`action_login`) hardcodes `GET /_matrix/client/r0/login`
   for the flows probe (and `r0/login/sso/redirect` for SSO, unused).
   Everything matrix-nio issues uses `MATRIX_API_PATH_V3 =
   '/_matrix/client/v3'` (nio 0.25.2 `Api._build_path` default). So:
   r0 alias needed ONLY for `GET /login`; all other endpoints are v3.
2. **Token via header or query?** On the wire: **`Authorization: Bearer`
   HEADER.** nio's `Api.*` methods build paths with `?access_token=`,
   but `AsyncClient.send()` (nio 0.25.2, async_client.py ~line 803)
   strips the query param and sends `Authorization: Bearer <token>`
   instead whenever `access_token` is set — confirmed by the server log
   showing whoami with NO query string returning 200. (Server keeps
   accepting both — header AND query param — per phase-1 step 1.4;
   the query-param path is harmless and useful for curl.)
3. **Does it call `/_matrix/client/versions`?** NO — not in the login,
   send, listen, or tail paths (the only `versions` references in
   matrix-commander are `--rest` help text; nio issues no versions call
   here). Nothing is needed in the response; Phase 1 still adds the
   endpoint per its step 1.3 (cheap, spec-shaped).
4. **Unexpected endpoints in the login/listen path?** YES, one:
   `POST /v3/keys/upload` — matrix-commander constructs nio with
   `encryption_enabled=True` unconditionally, and with a `--store`
   present nio uploads device keys on its first sync. `--plain` keeps
   rooms unencrypted so no further E2EE traffic is expected;
   `keys/query` at most login-time noise. No `whoami`, no
   `joined_rooms`, no filter endpoints in these flows.
5. **Exact `/sync` query params used:** `access_token` (always),
   `timeout` (ms, stringified; `10000` at the startup full sync),
   `full_state` (`'true'` at startup / `'false'` in the listen loop),
   `since` (from the persisted store token once a first sync has
   happened). No `filter`, no `set_presence` from these flows.

## Pending (updated after Phase 1 re-run)

- Wire confirmation of rows 2–6 (login POST, startup sync, keys/upload,
  send) with real response shapes — the current 404/401 wall stops the
  client before these fire. Phase-0 step 0.1 explicitly schedules this
  re-run; its results will be appended here and marked **[wire]**.

## Post-Phase-1 wire re-run (CONFIRMED on the wire, 2026-08-23)

With login + whoami + versions + r0-login-GET implemented, the
authenticated flows were re-captured (`raw-login2.log`, `raw-send.log`,
server console). Confirmations and one correction:

- Row 1 (GET r0/login) — login now SUCCEEDS end-to-end (exit 0):
  r0 flows probe then `POST /_matrix/client/v3/login` with the nio body
  (`type`, `identifier:{type:'m.id.user', user}`, `password`,
  `device_name`) — response parsed from `{user_id, access_token,
  device_id, home_server}`. **[wire]**
- CORRECTION to row 8: **`GET /_matrix/client/v3/account/whoami` IS in
  the critical path** — matrix-commander `restore_login` validates stored
  credentials with whoami on EVERY authenticated invocation (send,
  listen, tail). nio `WhoamiResponse` requires `user_id`
  (`device_id`/`is_guest` optional). **[wire]** (Implemented during
  Phase 1 — pulled forward from phase-2 step 2.4's sanctioned stub list;
  recorded as a capture-driven substitution.)
- Row 6 CONFIRMED: `POST /_matrix/client/v3/keys/upload` fires on every
  authenticated startup (encryption_enabled=True + `--store` present).
  A 404 response did NOT stop the send flow. **[wire]**
- Row 3 CONFIRMED + refined: the startup sync is
  `GET /_matrix/client/v3/sync?full_state=true&timeout=30000`
  (`timeout=30000` on the restore/startup path). The token arrives as a
  Bearer header (see the note below) — hence no `access_token` in the
  logged query string. **[wire]**
- **NEW, load-bearing: the SEND path requires a working `/sync`.** nio's
  `room_send` does `room = self.rooms[room_id]` client-side, and
  `self.rooms` is populated from the startup sync's `rooms.join` map. A
  404 sync → empty rooms dict → `KeyError <room_id>` → send fails BEFORE
  the PUT is ever attempted (E151). So `/sync` (at least a join map
  naming the room) is required for Act 1, not only for Act 2. **[wire]**

## Note on `?access_token=` vs the wire

Resolved during the Phase 1 re-run: nio's Api layer CONSTRUCTS paths with
`?access_token=`, but `AsyncClient.send()` rewrites them to
`Authorization: Bearer` headers before transmission (async_client.py).
The server must accept the header (matrix-nio's actual wire behavior);
accepting the query param as well (phase-1 step 1.4) is belt-and-braces
and eases curl debugging. No endpoint may rely on the query param alone.

## Act 2 listen-flow wire capture (2026-08-23, all flows working)

`raw-listen2.log` + server console: the `--listen forever` loop is
exactly `GET /v3/sync` with the Bearer header and these params —
`full_state=true` on the startup sync (no `since` on the very first
call), then `since=s<n>&timeout=30000` long-polls. `timeout=30000` is
the client's long-poll budget; the server caps at the same. The listener
printed the relayed message with `event_id: $<32-char commit hash>`
(Mode B), matching the sender's response id exactly. The `--tail` flow
was not separately re-run (its `room_messages` path is row 5 and already
implemented; plan §8 already allows dropping `--tail` from the demo
choreography if heavy).
