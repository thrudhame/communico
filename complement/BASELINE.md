# Complement baseline - 2026-11-13 11:42:10 PST

- checkout: ~/Sources/matrix-org-complement @ 0116400
- image: communico-complement:local (commit c51c7f87b72a6a9da51304d08e77c1b5505e62b9)
- go test exit: 1 (red tests are the baseline, not a harness error)
- packages: pass=13 fail=2 skip=0
- failing tests: 14

## Change from the previous baseline

Overnight F4 reduces the tracked baseline from 15 failures to 14, with no new
failures. The unchanged full corpus produced 677 terminal test results across
15 packages; the no-new-failure comparator and unchanged settings pass exit 0.

| # | Explicitly observed passing under full load | Elapsed |
|---|---|---|
| 1 | `TestOutboundFederationIgnoresMissingEventWithBadJSONForRoomVersion6` | 9.08 s |
| 2 | `TestMSC4297StateResolutionV2_1_includes_conflicted_subgraph` | 12.86 s |
| 3 | `TestMSC4297StateResolutionV2_1_starts_from_empty_set` | 12.19 s |
| 4 | `TestCorruptedAuthChain` | 18.87 s |

These are actual pass events, not inferred absence or skips. Native full
coverage is 1281 tests and 949 steps with zero failures. No Complement fixture,
test, deadline, settings or recovery concurrency changed. This baseline-only
amendment does not change the tested runtime inputs.

### Historical G7 baseline

G7 reduces the tracked baseline from 18 failures to 15, with no new failures.
`TestSyncTimelineGap`, `/full` and `/incremental` were explicitly observed passing
in the unchanged full corpus, not inferred passing from absence. The default
pass retains the red baseline; the unchanged settings pass and the
no-new-failure comparator exit 0.

Stable `msc4222` TestSync, ordinary TestSync, federation invite rejection,
knocking and the conflicted-subgraph parent also explicitly pass. Native full
coverage is 949 tests and 333 steps with zero failures, including real departure
schema, both state forms, raw event format and inclusive pagination cuts.
The OOB departure and lazy-member contracts identified by G6 are corrected;
the cumulative source re-check is separate from this red conformance baseline.
No Complement fixture, test, deadline or recovery concurrency changed.

The documentation-only baseline commit does not change these tested inputs.

### Historical G5b baseline

G5b's clean production tip retains the same 18 failures: new[], fixed[],
comparator exit 0. The default pass retains its red baseline; the unchanged
settings pass exits 0. The conflicted-subgraph parent explicitly passed in
14.53 s. That test elapsed time is not an inbound transaction measurement.
Full-load server-side timing is a separate G5b proof, not a timeout waiver.
No Complement fixture, test, deadline or recovery concurrency was changed.

The documentation-only baseline commit does not change these tested inputs.

### Historical G5 baseline

G5's exact production tip has the same 18 failing tests/subtests as the G3
baseline: no new failures and no removed entries. The full default pass and the
unchanged settings pass both completed; the no-new-failure comparator exited 0.
The documentation-only baseline commit does not change the tested runtime inputs.

| # | Explicitly observed passing in this full run |
|---|---|
| 1 | Stable `msc4222` package `TestSync`, including public/private lazy-member state_after cases |
| 2 | Ordinary client `TestSync`, `TestRoomsInvite` and `TestPushRuleRoomUpgrade` |
| 3 | `TestFederationRoomsInvite`, `TestFederationRejectInvite`, `TestKnocking` and `TestKnockingInMSC3787Room` |
| 4 | `TestMSC4289PrivilegedRoomCreators_Upgrades` and `TestMSC4291RoomIDAsHashOfCreateEvent_UpgradedRooms` |
| 5 | `TestAvatarUrlUpdate`, with the unchanged Complement fixture and Synapse-compatible optional semantic validation |
| 6 | `TestMSC4297StateResolutionV2_1_includes_conflicted_subgraph` |

These are observed passes, not tests inferred passing from absence. At G5 merge,
the earlier load-sensitive v12 deadline failures became the mandatory G5b latency
investigation and correction (T-G5-3); they were not added to the baseline or waived as flakes.
Known timeline-gap and OOB departed-state shape shortcomings remain documented;
this run is not a claim of cumulative Matrix conformance.

### Historical G3 improvement

No new failures. The previous 59 failing tests/subtests decreased to 18;
all 41 removed entries were observed passing, not merely absent or skipped.
This image uses f2061ac production code; 92316a7 changes native test inventory
and assertions only. The same production inputs passed real discovery interop
against stock Synapse and tuwunel.

| # | Newly passing coverage |
|---|---|
| 1 | Client space summary graph, depth, pagination, redacted links, suggested-only and join-rule cases; federated client spaces |
| 2 | Restricted room local joins, creator-free v11/v12 joins, remote joins, failover, local-user joins and local/federation space summaries |
| 3 | Room-summary allowed-room IDs, including restricted and non-restricted cases |
| 4 | `TestOutboundFederationProfile` and `TestRemoteAliasRequestsUnderstandUnicode`, required by OPEN-P01 |
| 5 | Federation/local PNG thumbnail cases, remote PNG client-v1 thumbnail case, filename override cases and client-v1 media without a filename |
| 6 | `TestMSC4297StateResolutionV2_1_starts_from_empty_set` |

Results are observations of this run, including previously flaky media cases;
they do not imply that this discovery change corrected every listed subsystem.

## Per-setting runs

The same image and checkout are used for every pass; the user filter applies to all passes.
Package totals above count each package once, failing if any pass fails.

| # | Pass | Test | Environment override | Go test exit |
|---|---|---|---|---|
| 1 | default | All except configured tests | Defaults | 1 |
| 2 | settings-1 | TestUnrejectRejectedEvents | PASS_COMMUNICO_FEDERATION_UNGROUNDEDMILLIHOURS=0 | 0 |

## Failing packages

- github.com/matrix-org/complement/tests
- github.com/matrix-org/complement/tests/csapi

## Failing tests (red to beat)

- github.com/matrix-org/complement/tests/csapi TestRoomCreate/Parallel/POST_/createRoom_creates_a_room_with_the_given_version
- github.com/matrix-org/complement/tests/csapi TestRoomCreate/Parallel
- github.com/matrix-org/complement/tests/csapi TestRoomCreate
- github.com/matrix-org/complement/tests TestJoinFederatedRoomFromApplicationServiceBridgeUser
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode/Can_download_with_Unicode_file_name_over_federation
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel
- github.com/matrix-org/complement/tests TestMediaFilenames
- github.com/matrix-org/complement/tests TestMediaWithoutFileName/parallel/Can_download_without_a_file_name_over_federation
- github.com/matrix-org/complement/tests TestMediaWithoutFileName/parallel
- github.com/matrix-org/complement/tests TestMediaWithoutFileName
- github.com/matrix-org/complement/tests TestRemotePngThumbnail/test_/_matrix/media/v3_endpoint
- github.com/matrix-org/complement/tests TestRemotePngThumbnail
- github.com/matrix-org/complement/tests TestJumpToDateEndpoint
