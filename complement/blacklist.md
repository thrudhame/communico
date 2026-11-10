# Complement blacklist (M0) — Complement is the compass, not the target.

Two sections, one rationale each. The human file is the source:
`complement/run.sh` applies the machine form (`//go:build
!communico_blacklist`
atop each listed file in a scratch copy of the Complement checkout) and runs
`go test -tags communico_blacklist`. Files are listed only on positive evidence
of a category match — everything else RUNS (red or green; red is the honest
baseline). Case-level exclusions (3PID issuance cases inside `TestRegistration`,
history-surgery and rate-limit cases inside runnable files) cannot be
build-tagged per file and are triaged in `complement/BASELINE.md`, not here.

## Principled / permanent (will never implement)

- `/_synapse/admin` (Synapse-specific admin/registration API).
- Unstable-MSC packages (stable Matrix only).
- 3PID / identity-server / email+msisdn _issuance_ and history surgery
  (retention/purge/erasure — native rooms are append-only by ruling):
  case-level, inside runnable files — triaged in BASELINE.md.

The user's spec-gaps P01 ruling supersedes the old M5a no-proxy default for
alias/profile discovery. Anonymous remote lookups now follow the spec through
normal federation admission; `federation.lookups=known` and `none` retain the
admin alternatives. `TestOutboundFederationProfile` and
`TestRemoteAliasRequestsUnderstandUnicode` are required to pass, not intentional
red cases.

- tests/csapi/admin_test.go
- tests/msc2836/msc2836_test.go
- tests/msc3391/msc3391_test.go
- tests/msc3757/owned_state_test.go
- tests/msc3874/room_messages_relation_filter_test.go
- tests/msc3890/msc3890_test.go
- tests/msc3902/federation_room_join_partial_state_test.go
- tests/msc3930/msc3930_test.go
- tests/msc3967/msc3967_test.go
- tests/msc4140/delayed_event_test.go
- tests/msc4155/invite_filter_test.go
- tests/msc4222/msc4222_test.go
- tests/msc4306/thread_subscriptions_test.go
- tests/msc4306/thread_subscriptions_sliding_sync_test.go
- tests/msc4429/msc4429_test.go

## Scheduled (will implement at the named milestone)

- E2EE: device keys, device lists and to-device delivery run locally and over
  federation. Cross-signing and encrypted key backup are implemented; backup
  replacement consumers run in the corpus.
- Push rules, aggregate counts and thread notification counts run.
- Federation — rooms landed in M5b (the room-federation files run: joins,
  sends, missing events, invites, event auth, redaction, sync, unreject,
  bans, presence, typing, ACLs, knocking, restricted joins and media).
  Device/E2EE federation files run after E3. Media's legacy anonymous remote
  cases remain visible in the red baseline: local-only legacy serving does not
  grant permission for anonymous foreign fetches.
- Event authorization — landed M4 (rulebook M3 + room endpoints M4).
- Room version 12 — landed (the v12 plan): v10/v12 registered in the
  rulebook; the v12 corpus runs. Federation-flavoured v12 tests stay
  red under the M5 line, not here.
- Rate limiting (`M_LIMIT_EXCEEDED` — M2): case-level, triaged in BASELINE.md.

## Never blacklisted

`30rooms`, `31sync`, redaction wire semantics (the engine contract under test);
`50federation` is scheduled, not principled (it is the only external legitimacy
signal for stable versions). `/register`, `/login`, `/logout` stay runnable (red
at M0 — F1's first rung).
