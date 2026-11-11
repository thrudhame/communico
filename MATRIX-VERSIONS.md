# Matrix version requirement checklist

`/_matrix/client/versions` lists every version from v1.1 through v1.16.
Each row inherits every preceding row, including the baseline below. The source
audit uses Matrix v1.16, commit `81a864545f7d948a881f5227700e5312c64f506e`.
This is a regression checklist, not exhaustive conformance certification.

## Endpoint baseline

[`tests/fixtures/versions-endpoints.json`](tests/fixtures/versions-endpoints.json)
retains all 197 tagged client-server/server-server operation definitions from the
G10 audit: 167 routed and 30 explicitly excluded. Duplicate definitions remain.
The guard checks every concrete route and its callable handler, not a passing
test count. Generic federation query maps to directory/profile. Optional 3PID,
identity servers, appservices, SSO/OAuth, tokens and deprecated global sync APIs
remain excluded; federation v1 invite is excluded by room-version 1/2 scope.
The existing versions 3-12 registry is unchanged. Whois records no connections.

## Cumulative behavioral requirements

Each row names executable contract suites. The guard runs these suites in a
separate process and requires their named cases to run successfully. Removing a
route, suite or assertion that exposes a regression blocks the advertisement.
The suites test the named contracts and their sibling paths; they do not certify
every historical Matrix error branch. The full native suite remains required.

| #  | Version | Required additions/contracts                                                                                                             | Contract suites                                                                                                                             |
| -- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | v1.1    | Baseline routes; sync continuity/repair, full OOB departure, mandatory lazy own/gap membership; keys, backup, knock, reports and filters | `http-sync-gaps`, `http-sync`, `http-sync-filter-contract`, `http-reports`, `http-knocking`, `http-e2ee-key-backup`, `http-small-endpoints` |
| 2  | v1.2    | Spaces/hierarchy, restricted admission, typed rooms and fallback-key transport                                                           | `http-room-discovery`, `http-restricted-membership`, `e2ee-keys`                                                                            |
| 3  | v1.3    | Optional messages from, refresh retry/rotation, relations and room-version auth                                                          | `http-refresh-token`, `http-relations`, `http-room-read`                                                                                    |
| 4  | v1.4    | Private/thread receipts, fully_read, thread ordering/bundles and room-type directories                                                   | `http-thread-receipts`, `http-relations`, `http-room-discovery`                                                                             |
| 5  | v1.5    | Reference transport, refresh input, push actions/placement and key counts                                                                | `http-pushrules`, `http-refresh-token`, `e2ee-keys`                                                                                         |
| 6  | v1.6    | Timestamp lookup, unknown route/method errors, key document and zero-limit context                                                       | `http-timestamp`, `http-contract`, `http-federation-keys`, `http-room-read`                                                                 |
| 7  | v1.7    | Async media, mentions/property push conditions, device+endpoint transactions through refresh                                             | `http-media`, `push-evaluator`, `http-room-write`                                                                                           |
| 8  | v1.8    | Joined event reporter, v11 rules and null room-type filtering                                                                            | `http-reports`, `http-room-discovery`, `historical-identifiers`                                                                             |
| 9  | v1.9    | suppress_edits/main/root scope, fallback signed content and hierarchy via                                                                | `push-evaluator`, `http-thread-receipts`, `e2ee-keys`, `http-room-discovery`                                                                |
| 10 | v1.10   | Erasure visibility, relation recursion/depth, protected push account data and thread batches                                             | `http-erasure`, `http-relations`, `http-client-data`, `http-thread-receipts`                                                                |
| 11 | v1.11   | Authenticated/federation media including filenames, token compatibility and cross-signing                                                | `http-remote-media`, `http-media-thumbnail`, `http-auth`, `http-e2ee-cross-signing`                                                         |
| 12 | v1.12   | Join/knock via, media filename/type/disposition and no-op legacy push actions                                                            | `http-knocking`, `http-media`, `push-evaluator`                                                                                             |
| 13 | v1.13   | Room reports, typing/receipt ACLs, pusher custom data and FIFO OTKs                                                                      | `http-reports`, `federation-acl`, `http-push-delivery`, `e2ee-keys`                                                                         |
| 14 | v1.14   | User reports, historical identifiers and peeking/hierarchy                                                                               | `http-reports`, `historical-identifiers`, `http-room-discovery`                                                                             |
| 15 | v1.15   | Room summary/access/via, public profiles/directory and restricted authorizer                                                             | `http-room-discovery`, `http-discovery-lookups`, `http-restricted-membership`                                                               |
| 16 | v1.16   | Extended profiles, state GET format, state_after, room12/create/upgrade, prejoin/unsigned hints and nested thread formatting             | `http-profile-fields`, `http-sync`, `http-prejoin-formats`, `http-relations`, `http-room-directory`, `historical-identifiers`               |

## Inherited G8 contract cases

These exact cases protect the three inherited defects found by the cumulative
audit. Both state forms and the real pagination/client consumers are exercised.

| # | Suite file       | Required case                                                                       |
| - | ---------------- | ----------------------------------------------------------------------------------- |
| 1 | `http-sync-gaps` | `remote imported gap limits sync and its cursor resumes through missing history`    |
| 2 | `http-sync`      | `OOB invitation and rejection advance tokens once; ignored invitations stay hidden` |
| 3 | `http-sync-gaps` | `lazy full-state zero timeline keeps own membership in both state forms`            |
| 4 | `http-sync-gaps` | `lazy limited gaps retain changed absent senders and unchanged timeline senders`    |

Room versions are independent of API version labels. Optional client-side crypto,
guest/3PID modules and recommended defaults are not newly claimed server features.
Creation-policy `io.element.e2ee_forced.*` flags keep their configured meaning.
