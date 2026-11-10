# Complement baseline - 2026-11-10 06:08:42 PST

- checkout: ~/Sources/matrix-org-complement @ 0116400
- image: communico-complement:local (commit 0d485426d0e290c436b6f4f57d4b0397f101bfc5)
- go test exit: 1 (red tests are the baseline, not a harness error)
- packages: pass=13 fail=2 skip=0
- failing tests: 18

## Change from the previous baseline

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
- github.com/matrix-org/complement/tests TestOutboundFederationIgnoresMissingEventWithBadJSONForRoomVersion6
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
- github.com/matrix-org/complement/tests/csapi TestSyncTimelineGap/incremental
- github.com/matrix-org/complement/tests/csapi TestSyncTimelineGap/full
- github.com/matrix-org/complement/tests/csapi TestSyncTimelineGap
