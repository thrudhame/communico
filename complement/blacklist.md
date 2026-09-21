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

- E2EE (later; Complement-Crypto out of scope).
- Push (later).
- Federation — M5 (`50*` + `federation_*`; the :8448 stub serves TLS + 404 so
  Complement fails fast, not on timeouts). Knock/restricted joins ride along:
  `knocking*` share the `testValidationForSendMembershipEndpoint` helper defined
  in blacklisted `federation_room_join_test.go` (a second `//go:build` line is
  illegal in Go, so they are excluded rather than given a duplicate tag).
- Event authorization — landed M4 (rulebook M3 + room endpoints M4).
- Room version 12 — landed (the v12 plan): v10/v12 registered in the
  rulebook; the v12 corpus runs. Federation-flavoured v12 tests stay
  red under the M5 line, not here.
- Rate limiting (`M_LIMIT_EXCEEDED` — M2): case-level, triaged in BASELINE.md.

- tests/csapi/e2e_key_backup_test.go
- tests/csapi/upload_keys_test.go
- tests/csapi/user_query_keys_test.go
- tests/csapi/keychanges_test.go
- tests/csapi/device_lists_test.go
- tests/csapi/to_device_test.go
- tests/csapi/push_test.go
- tests/csapi/thread_notifications_test.go
- tests/federation_acl_test.go
- tests/federation_device_list_update_test.go
- tests/federation_event_auth_test.go
- tests/federation_keys_test.go
- tests/federation_media_content_test.go
- tests/federation_presence_test.go
- tests/federation_query_profile_test.go
- tests/federation_redaction_test.go
- tests/federation_room_alias_test.go
- tests/federation_room_ban_test.go
- tests/federation_room_event_auth_test.go
- tests/federation_room_get_missing_events_test.go
- tests/federation_room_invite_test.go
- tests/federation_room_join_test.go
- tests/federation_room_send_test.go
- tests/federation_rooms_invite_test.go
- tests/federation_room_typing_test.go
- tests/federation_sync_test.go
- tests/federation_to_device_test.go
- tests/federation_unreject_rejected_test.go
- tests/federation_upload_keys_test.go
- tests/knocking_test.go
- tests/knock_restricted_test.go

## Never blacklisted

`30rooms`, `31sync`, redaction wire semantics (the engine contract under test);
`50federation` is scheduled, not principled (it is the only external legitimacy
signal for stable versions). `/register`, `/login`, `/logout` stay runnable (red
at M0 — F1's first rung).
