# Complement baseline - 2026-11-10 02:13:39 PST

- checkout: ~/Sources/matrix-org-complement @ 0116400
- image: communico-complement:local (commit f2061ac71564b26ff98c01eb4df20342f31facee)
- go test exit: 1 (red tests are the baseline, not a harness error)
- packages: pass=13 fail=2 skip=0
- failing tests: 18

## Change from the previous baseline

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
