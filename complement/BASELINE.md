# Complement baseline - 2026-11-07T07:16:36.445Z

- checkout: ~/Sources/matrix-org-complement @ 0116400
- image: communico-complement:local (commit 5535f3bc81cec266f83f3d00edf691276bc656c4)
- go test exit: 1 (red tests are the baseline, not a harness error)
- packages: pass=13 fail=2 skip=0
- failing tests: 59

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

- github.com/matrix-org/complement/tests TestOutboundFederationProfile/Outbound_federation_can_query_profile_data
- github.com/matrix-org/complement/tests TestOutboundFederationProfile
- github.com/matrix-org/complement/tests TestRemoteAliasRequestsUnderstandUnicode
- github.com/matrix-org/complement/tests TestOutboundFederationIgnoresMissingEventWithBadJSONForRoomVersion6
- github.com/matrix-org/complement/tests/csapi TestRoomCreate/Parallel/POST_/createRoom_creates_a_room_with_the_given_version
- github.com/matrix-org/complement/tests/csapi TestRoomCreate/Parallel
- github.com/matrix-org/complement/tests/csapi TestRoomCreate
- github.com/matrix-org/complement/tests TestJoinFederatedRoomFromApplicationServiceBridgeUser
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/ASCII/Can_download_specifying_a_different_ASCII_file_name
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/ASCII/Can_download_specifying_a_different_ASCII_file_name_over__matrix/client/v1/media/download
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode/Can_download_specifying_a_different_Unicode_file_name
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode/Can_download_with_Unicode_file_name_over_federation
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode/Can_download_with_Unicode_file_name_over_federation_via__matrix/client/v1/media/download
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode/Can_download_specifying_a_different_Unicode_file_name_over__matrix/client/v1/media/download
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/Unicode
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel/ASCII
- github.com/matrix-org/complement/tests TestMediaFilenames/Parallel
- github.com/matrix-org/complement/tests TestMediaFilenames
- github.com/matrix-org/complement/tests TestMediaWithoutFileName/parallel/Can_download_without_a_file_name_over_federation
- github.com/matrix-org/complement/tests TestMediaWithoutFileName/parallel
- github.com/matrix-org/complement/tests TestMediaWithoutFileName
- github.com/matrix-org/complement/tests TestMediaWithoutFileNameCSMediaV1/parallel/Can_download_without_a_file_name_over_federation
- github.com/matrix-org/complement/tests TestMediaWithoutFileNameCSMediaV1/parallel
- github.com/matrix-org/complement/tests TestMediaWithoutFileNameCSMediaV1
- github.com/matrix-org/complement/tests TestLocalPngThumbnail/test_/_matrix/media/v3_endpoint
- github.com/matrix-org/complement/tests TestLocalPngThumbnail/test_/_matrix/client/v1/media_endpoint
- github.com/matrix-org/complement/tests TestLocalPngThumbnail
- github.com/matrix-org/complement/tests TestRemotePngThumbnail/test_/_matrix/media/v3_endpoint
- github.com/matrix-org/complement/tests TestRemotePngThumbnail/test_/_matrix/client/v1/media_endpoint
- github.com/matrix-org/complement/tests TestRemotePngThumbnail
- github.com/matrix-org/complement/tests TestFederationThumbnail
- github.com/matrix-org/complement/tests TestRestrictedRoomsSpacesSummaryLocal
- github.com/matrix-org/complement/tests TestRestrictedRoomsSpacesSummaryFederation
- github.com/matrix-org/complement/tests TestRestrictedRoomsLocalJoin/Join_should_succeed_when_joined_to_allowed_room
- github.com/matrix-org/complement/tests TestRestrictedRoomsLocalJoin/Join_should_fail_when_left_allowed_room
- github.com/matrix-org/complement/tests TestRestrictedRoomsLocalJoin
- github.com/matrix-org/complement/tests TestRestrictedRoomsRemoteJoin/Join_should_succeed_when_joined_to_allowed_room
- github.com/matrix-org/complement/tests TestRestrictedRoomsRemoteJoin/Join_should_fail_when_left_allowed_room
- github.com/matrix-org/complement/tests TestRestrictedRoomsRemoteJoin
- github.com/matrix-org/complement/tests TestRestrictedRoomsRemoteJoinLocalUser
- github.com/matrix-org/complement/tests TestRestrictedRoomsRemoteJoinFailOver
- github.com/matrix-org/complement/tests TestRestrictedRoomsLocalJoinNoCreatorsUsesPowerLevelsV12
- github.com/matrix-org/complement/tests TestRestrictedRoomsLocalJoinNoCreatorsUsesPowerLevelsV11
- github.com/matrix-org/complement/tests TestClientSpacesSummary/query_whole_graph
- github.com/matrix-org/complement/tests TestClientSpacesSummary/max_depth
- github.com/matrix-org/complement/tests TestClientSpacesSummary/suggested_only
- github.com/matrix-org/complement/tests TestClientSpacesSummary/pagination
- github.com/matrix-org/complement/tests TestClientSpacesSummary/redact_link
- github.com/matrix-org/complement/tests TestClientSpacesSummary
- github.com/matrix-org/complement/tests TestClientSpacesSummaryJoinRules
- github.com/matrix-org/complement/tests TestFederatedClientSpaces
- github.com/matrix-org/complement/tests TestRoomSummaryAllowedRoomIDs/restricted_room_includes_allowed_room_ids
- github.com/matrix-org/complement/tests TestRoomSummaryAllowedRoomIDs/non-restricted_room_omits_allowed_room_ids
- github.com/matrix-org/complement/tests TestRoomSummaryAllowedRoomIDs
- github.com/matrix-org/complement/tests TestJumpToDateEndpoint
- github.com/matrix-org/complement/tests TestMSC4297StateResolutionV2_1_starts_from_empty_set
- github.com/matrix-org/complement/tests/csapi TestSyncTimelineGap/incremental
- github.com/matrix-org/complement/tests/csapi TestSyncTimelineGap/full
- github.com/matrix-org/complement/tests/csapi TestSyncTimelineGap
