# communico

A Matrix homeserver with a Turso event-store core, Matrix client-server and
server-server APIs, and a private local admin API.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the current architecture.

The running server owns its Turso store. Start it with `deno task start` after
building the native library in the project test environment.

The former Doltgres implementation is preserved on `doltgres` at
`2d3944abaed7571fd8fe24a532860bd134a46d15`. Current integration tests live on
this branch under `tests/`.

Browser homeserver/native sync, home/VPS sync, store-image adoption, announce
digests and WebRTC/WebTransport are parked; Model B is a future expansion.
Parking does not change the browser's first-class homeserver expectation or
choose its storage engine. E2EE server APIs cover device and one-time/fallback
keys, durable to-device delivery, device lists, federation, cross-signing and
encrypted key backup. Clients own encryption, private keys and decryption.

## Client data and sync

`/_matrix/client/versions` advertises v1.1 through v1.16, individually and
cumulatively. [MATRIX-VERSIONS.md](MATRIX-VERSIONS.md) records the endpoint and
behavioral regression checklist, including optional-module exclusions. This is
not a claim that every Complement case passes; see `complement/BASELINE.md`.

Native simplified sliding sync (MSC4186) is advertised as
`org.matrix.simplified_msc3575`. Clients use the authenticated
`POST /_matrix/client/unstable/org.matrix.simplified_msc3575/sync` directly,
without a sliding-sync proxy. It supports list windows, room subscriptions,
required state and independent E2EE, to-device, account-data, receipt and typing
extensions. Password login remains supported. The layered `slidingsync` settings
bound connections, retained positions, request sizes and poll timeouts; unknown
or expired positions return `M_UNKNOWN_POS` rather than silently resetting.

Element X Android 26.10.1 has been exercised against native sync with password
login, existing/empty/invited rooms, device verification, encrypted key backup,
encrypted messages and persisted history in both directions, device changes and
reconnection after a transport outage. This acceptance used a GrapheneOS x86_64
emulator and a second Matrix Rust SDK client, not a physical phone. It does not
cover OAuth/MAS, QR login or calls.

`/sync?use_state_after=true` returns state at the response's timeline end in
`state_after` (also when empty), not `state`. The default retains the legacy
state-before-timeline contract. Filters and lazy member loading apply to both.
The older `org.matrix.msc4222.use_state_after` query uses the same state cut and
returns `org.matrix.msc4222.state_after`; an explicit stable query wins.

MSC4140 delayed events are off by default, like Synapse. Set
`delayedevents.maxdelayms` to a positive millisecond limit (for example 86400000
for 24 hours) and `delayedevents.maxperuser` to a positive pending-event limit
(default 100) to enable scheduling and the `org.matrix.msc4140` flag. Capabilities
publish both limits. Ordinary send/state routes accept `org.matrix.msc4140.delay`;
they return a `delay_id`, not an immediate event. Scheduling, heartbeat restart,
cancel and immediate-send management are durable across server restart. Disabling
new scheduling does not abandon previously scheduled work.

Delayed delivery rechecks current room authorization and encryption policy.
Another sender's published change to the target state cancels a pending command;
the owner's own state updates do not cancel its delayed call leave. List/get
require the owner's authentication. Cancel/restart/send accept the unguessable
delay ID as a bearer credential, as current Synapse does, so clients must keep it
private. The shared access logger redacts these path credentials.

Room tags use the standard tags API and the same private `m.tag` room account
data clients can read and write directly. Tag changes wake incremental sync.
Stored and inline sync filters support room and sender inclusion/exclusion,
type globs, URL matching, state, presence, ephemeral and account-data selection.
Filtered events still advance stream tokens; E2EE control streams and unread
counts are not content-filtered.

OpenID tokens are distinct, expiring credentials issued through the own-user
`openid/request_token` API. Third parties can call federation `openid/userinfo`
with that token, without a federation signature. The tokens cannot authorize
client APIs. `openid.tokenseconds` controls their lifetime (default 3600 seconds);
account deactivation revokes them.

## Jump to date

Authenticated client and signed federation `timestamp_to_event` support inclusive
jump-to-date searches. Remote hits are verified and imported as usable history
anchors, so clients can request context and paginate earlier events without
turning old history into new sync traffic. Timestamp ties follow causal order,
not untrusted remote depths. Forward pagination fills from held newer boundaries
and crosses only proved event edges; unavailable connections remain resumable gaps.

## What end-to-end encryption does not hide

**These are limits of the Matrix protocol and Matrix clients, not limitations
specific to communico. Encrypting protocol-required cleartext would break
compatibility with other Matrix servers and clients.**

Communico's goal is end-to-end encryption as tight as Matrix allows.

Rooms created by local users use Megolm encryption by default. Spaces are
exempt because their content is state; server-notice creation has no public
exemption. Clients cannot bypass enforcement by claiming a server-notice type.
Local users cannot send plaintext non-state events into encrypted rooms,
except redactions, the standard in-room key-verification exchange and, by default,
standard relation-only reactions. A plaintext `m.reaction` must contain only
`m.relates_to`, with exactly `rel_type: "m.annotation"`, string `event_id` and
string `key`. Body text, extension fields and other relation shapes are not
reaction exceptions. Any reaction key string is legal, including text; this
policy does not prevent a malicious client encoding text in visible metadata.
State
remains plaintext. Local encryption downgrade/redaction is blocked while
unencrypted creation is disabled; remote events retain normal Matrix validity.

Administrators control four independent settings in `[encryption]`:

| # | Config name                            | Default | Effect when false                                                                                                          |
| - | -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1 | `encryption.allowunencryptedcreation`  | `false` | Insert Megolm at room creation and protect local encryption state from downgrade/removal                                   |
| 2 | `encryption.allowunencryptedjoining`   | `true`  | Refuse local joins/knocks to known plaintext rooms; leave unknown remote plaintext rooms after joining and return an error |
| 3 | `encryption.allowunencryptedmessages`  | `false` | Refuse local plaintext non-state events in encrypted rooms, with the exceptions above                                      |
| 4 | `encryption.allowunencryptedreactions` | `true`  | Remove the relation-only reaction exception; reactions then follow `allowunencryptedmessages`                              |

Environment overrides are `COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDCREATION`,
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDJOINING`,
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDMESSAGES` and
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDREACTIONS`. The planned Admin UI lists
"Accept unencrypted reactions" with the other encryption controls. Call reaction
extensions, polls and other plaintext event types gain no exception.
Strict remote join refusal
may briefly join before discovering the room's authoritative encryption state.
Interrupted cleanup remains durable and visible in federation-outbox review;
it retries through the federation sender. Existing members are not evicted.
The three `io.element.e2ee_forced.*` `/versions` flags reflect creation policy.

## Knocking

Local users can knock on rooms whose join rule allows it. `/sync` exposes only
`rooms.knock` prejoin state, not a joined timeline. Acceptance is a normal
invitation; the client chooses whether to join. A repeated knock updates its
reason and rechecks the resident's current state. Reasons, profiles and prejoin
state are plaintext Matrix metadata, even in encrypted rooms.

Unknown remote knocks are allowed under strict encryption joining policy:
stripped state is not authoritative proof of encryption. The subsequent join
still enforces that policy. Remote knock attempts and retractions survive restart;
ambiguous responses retry the same signed event. Knock reconciliation/retraction
uses `federation.refusedmillihours`, with expired work retained in outbox review
for explicit retry. Existing invite rejection jobs remain nonexpiring. Remote
kick/ban notification is not guaranteed by Matrix; unproven terminal events do
not become membership truth on the knocker's server.

Restricted rooms support local and federated joins based on current membership
in an allowed room. An invite bypasses that condition; leaving the allowed room
after authorization does not evict an existing member. The authorizing resident
must have a joined user with invite power and countersigns the join. A local
user can obtain that authorization from another resident even when our server
already participates. Authorizer signatures are verified on every remote
receipt path, not trusted because a signature entry exists.

New rooms use Synapse-compatible invite defaults: `public_chat` requires power
50, while `private_chat` and `trusted_private_chat` use 0. An explicit preset
wins; otherwise public visibility selects `public_chat`, and private/default
visibility selects `private_chat`. Explicit power-level overrides and initial
state still win. Existing rooms keep their stored power levels.

Matrix E2EE protects payloads that clients encrypt, not the whole protocol.
These limits apply even in an encrypted room. HTTPS protects transport, but
the receiving server can still read fields outside the encrypted payload.

"Our server" means your account's homeserver. "Room servers" means homeservers
participating in that room. Room data is also visible to users allowed to
receive it by [membership and history visibility][e2ee-history], including
new joiners or people peeking where permitted. Unencrypted does not mean
universally public.

In the table, **Protocol** means standard Matrix exposes the data;
**Client** means clients can avoid the disclosure. **Mixed** combines
client-encryptable payloads with protocol-visible fields or state media.

| #  | Limit    | Not hidden by room E2EE                                                                                                                                                     | Visible to whom                                                                                                                                                                                         | Matrix spec                                                                           |
| -- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1  | Protocol | All room state: name, topic, avatar, members and membership changes, join rules, power levels, history visibility, aliases, and the encryption setting itself               | Our server and room servers; permitted readers. Invites/knocks can expose selected state before joining.                                                                                                | [State][e2ee-state], [stripped state][e2ee-stripped]                                  |
| 2  | Protocol | Space metadata and room hierarchy (`m.space.child`, `m.space.parent`)                                                                                                       | Our server and room servers; users allowed to discover the hierarchy. Spaces hold state, which Matrix does not encrypt.                                                                                 | [Spaces][e2ee-spaces], [no encrypted state][e2ee-no-state]                            |
| 3  | Protocol | Event sender, room ID, timestamps, event IDs, ciphertext size, encryption algorithm and session ID; device/sender-key fields when present                                   | Our server, room servers and permitted readers. Size means encrypted event size, not exact plaintext length.                                                                                            | [Event format][e2ee-events], [Megolm][e2ee-megolm]                                    |
| 4  | Protocol | `m.relates_to`: reply, thread, edit and reaction targets, relationship types, and reaction keys (emoji or any string), even when other payloads are encrypted               | Our server, room servers and permitted readers                                                                                                                                                          | [Relationships][e2ee-relations], [reactions][e2ee-reactions]                          |
| 5  | Mixed    | Redaction targets (`redacts`) must be clear; an optional client-supplied reason is also clear when sent                                                                     | Our server, room servers and permitted readers                                                                                                                                                          | [Redactions][e2ee-redactions]                                                         |
| 6  | Protocol | Typing notifications and public read receipts, including event/thread IDs and receipt timestamps                                                                            | Our server, room servers and room members. Private read receipts stay with our server and the sending user; they are not E2EE.                                                                          | [Typing][e2ee-typing], [receipts][e2ee-receipts]                                      |
| 7  | Protocol | Presence, last-active information and status messages, when sent                                                                                                            | Our server; interested remote servers and users sharing rooms                                                                                                                                           | [Presence][e2ee-presence]                                                             |
| 8  | Protocol | User profiles: display names, avatars and other published profile fields                                                                                                    | Our server; remote servers and users permitted to query them. Room membership also carries display names and avatars.                                                                                   | [Profiles][e2ee-profiles]                                                             |
| 9  | Mixed    | Account data (except values clients separately encrypt, such as secret storage); push rules                                                                                 | Our server and your own clients, not other room members merely because they share a room                                                                                                                | [Account data][e2ee-account], [push rules][e2ee-push], [secret storage][e2ee-secrets] |
| 10 | Protocol | Device lists, device names, public device/cross-signing keys and published one-time/fallback keys                                                                           | Our server; querying clients and remote servers receiving key/device information. Private keys are not published.                                                                                       | [Key distribution][e2ee-keys], [device federation][e2ee-devices]                      |
| 11 | Mixed    | To-device message contents unless the client Olm-encrypts them; sender, destination users/devices and routing type remain visible either way                                | Sending and receiving homeservers; the destination devices                                                                                                                                              | [To-device][e2ee-to-device], [Olm][e2ee-olm]                                          |
| 12 | Client   | URLs requested through server-side URL previews                                                                                                                             | Our server learns the URL, even if it came from an encrypted message                                                                                                                                    | [URL preview privacy][e2ee-previews]                                                  |
| 13 | Mixed    | Media and thumbnails uploaded without client-side attachment encryption; avatars and image packs have no standard encryption mechanism                                      | Uploading/serving servers and users able to retrieve the media. Encrypting the message alone does not encrypt its files; thumbnails need separate encryption too.                                       | [Attachments][e2ee-attachments], [media][e2ee-media], [image packs][e2ee-no-state]    |
| 14 | Protocol | Published room-directory entries: room IDs, names, topics, aliases, avatars and member counts                                                                               | The publishing server and anyone allowed to query its directory, without joining the listed room                                                                                                        | [Room directory][e2ee-directory]                                                      |
| 15 | Protocol | Push-notification routing and metadata sent to a push gateway                                                                                                               | Our server and the configured gateway; the provider sees what the gateway forwards. The notification format determines which fields are sent.                                                           | [Push notifications][e2ee-push]                                                       |
| 16 | Protocol | Connection IPs, request timing and traffic sizes                                                                                                                            | The servers you connect to and network observers (their view depends on transport/proxies). Room E2EE provides no traffic anonymity; it does not automatically give remote room servers your client IP. | [HTTP transport][e2ee-transport], [connection records][e2ee-connections]              |
| 17 | Mixed    | In-room key verification may be plaintext: fallback body, device/method negotiation, SAS/QR fields and cancellation reason are client-encryptable; the relation stays clear | Our server, room servers and permitted readers when the client sends plaintext. Communico retains this compatibility exception; these payloads are not all protocol-required cleartext.                 | [Verification][e2ee-verification]                                                     |
| 18 | Mixed    | Call-member and beacon-info state stays clear; call signaling, custom call reactions, poll votes and location payloads can be encrypted                                     | Our server, room servers and permitted readers can read state, not client-encrypted payloads                                                                                                            | [State][e2ee-state], [encryption][e2ee-megolm]                                        |

[Server-side search][e2ee-search] excludes encrypted rooms; clients must search
decrypted content locally. Access to encrypted events does not itself give a
reader the decryption keys, and recipients who receive keys can read the content.

Communico intends to explore its own protocol for some of these gaps later.
That longer-term direction has no promised coverage or dates.

[e2ee-history]: https://spec.matrix.org/unstable/client-server-api/#room-history-visibility
[e2ee-state]: https://spec.matrix.org/unstable/client-server-api/#types-of-room-events
[e2ee-stripped]: https://spec.matrix.org/unstable/client-server-api/#stripped-state
[e2ee-spaces]: https://spec.matrix.org/unstable/client-server-api/#spaces
[e2ee-no-state]: https://spec.matrix.org/unstable/client-server-api/#encrypted-image-packs
[e2ee-events]: https://spec.matrix.org/unstable/client-server-api/#room-event-format
[e2ee-megolm]: https://spec.matrix.org/unstable/client-server-api/#mmegolmv1aes-sha2
[e2ee-relations]: https://spec.matrix.org/unstable/client-server-api/#forming-relationships-between-events
[e2ee-reactions]: https://spec.matrix.org/unstable/client-server-api/#event-annotations-and-reactions
[e2ee-verification]: https://spec.matrix.org/unstable/client-server-api/#in-room-verification
[e2ee-redactions]: https://spec.matrix.org/unstable/client-server-api/#mroomredaction
[e2ee-typing]: https://spec.matrix.org/unstable/client-server-api/#typing-notifications
[e2ee-receipts]: https://spec.matrix.org/unstable/client-server-api/#receipts
[e2ee-presence]: https://spec.matrix.org/unstable/client-server-api/#presence
[e2ee-profiles]: https://spec.matrix.org/unstable/client-server-api/#profiles
[e2ee-account]: https://spec.matrix.org/unstable/client-server-api/#client-config
[e2ee-push]: https://spec.matrix.org/unstable/client-server-api/#push-notifications
[e2ee-secrets]: https://spec.matrix.org/unstable/client-server-api/#storage
[e2ee-keys]: https://spec.matrix.org/unstable/client-server-api/#key-distribution
[e2ee-devices]: https://spec.matrix.org/unstable/server-server-api/#device-management
[e2ee-to-device]: https://spec.matrix.org/unstable/client-server-api/#send-to-device-messaging
[e2ee-olm]: https://spec.matrix.org/unstable/client-server-api/#molmv1curve25519-aes-sha2
[e2ee-previews]: https://spec.matrix.org/unstable/client-server-api/#get_matrixclientv1mediapreview_url
[e2ee-attachments]: https://spec.matrix.org/unstable/client-server-api/#sending-encrypted-attachments
[e2ee-media]: https://spec.matrix.org/unstable/client-server-api/#content-repository
[e2ee-directory]: https://spec.matrix.org/unstable/client-server-api/#published-room-directory
[e2ee-transport]: https://spec.matrix.org/unstable/client-server-api/#api-standards
[e2ee-connections]: https://spec.matrix.org/unstable/client-server-api/#get_matrixclientv3adminwhoisuserid
[e2ee-search]: https://spec.matrix.org/unstable/client-server-api/#server-side-search

## Client discovery, calls and account inspection

`wellknown.client` publishes the explicit public homeserver base URL at
`/.well-known/matrix/client`; `wellknown.identity` optionally advertises an
identity server, without implementing one. Empty client URL returns 404.
`wellknown.support.page` and the `admin`/`security` `mxids`/`emails` lists
publish support information; no page or contacts returns 404. Both discovery
routes are public, allow cross-origin reads and work with federation disabled.

Authenticated `GET /_matrix/client/v3/voip/turnServer` returns `{}` until
`turn.uris` and credentials are configured. Use `turn.secret` for expiring
coturn-compatible HMAC credentials or `turn.username`/`turn.password` for static
credentials. The secret takes precedence. `turn.ttl` is seconds (default 3600;
0 disables credentials). This advertises an external TURN service, not a daemon.

`matrixrtc.livekitserviceurl` advertises an external LiveKit authorization
service through both well-known `org.matrix.msc4143.rtc_foci` and authenticated
`/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`. Empty (default)
disables discovery and its versions flag. Configure `wellknown.client` as usual
for public well-known. For example, set the service URL to
`https://rtc.example/livekit/jwt`; configure that service with the actual SFU
URL and credentials, and make this server's existing OpenID userinfo endpoint
reachable from it. No SFU or JWT service is bundled. This is the legacy
`livekit_service_url` transport for Element Call compatibility mode, not the
new URL-only token proxy. Standalone JWT-service authorization has its upstream
room-membership limitations; deploying it is an operator trust boundary, not
homeserver room authorization. Keep the service's allowed homeservers explicit.

`GET /_matrix/client/v3/pushrules/global/` returns the caller's global rule set.
Client `admin/whois/{userId}` permits self-inspection or a requester explicitly
listed by full local Matrix ID in `admin.users` (default empty). It returns
devices and active token sessions with empty `connections`: no IP, user-agent
or last-seen history is recorded. Public support contacts grant no privileges;
the private admin Unix socket's authorization is unchanged.

## Checks

Run inside the named, authorized project test VM or dedicated project LXC on
agora specified by the execution plan:

- `deno task check`
- `deno task test`
- `sh hooks/pre-commit`

`deno task test` and the Complement image explicitly permit plaintext for
their conformance corpus. Dedicated encryption-policy consumers exercise the
shipped defaults, the eight create/join/message combinations and independent
reaction/message toggle combinations across the local writers.

Configuration uses `defaults/communico.toml`, an optional
`config/communico.toml` overlay and `COMMUNICO_*` environment overrides.
`deno task config` prints the merged settings; it does not initialize storage.
The shipped defaults file is required even with a complete environment. Every
numeric setting has explicit safe-integer bounds; durations are checked after
unit conversion, including the signed 32-bit limit for timer delays. Invalid
settings fail startup rather than wrapping a timer or rounding a value.

Non-upload request bodies are limited before JSON parsing to 12.5 MiB by
`server.maxrequestbytes` (`COMMUNICO_SERVER_MAXREQUESTBYTES`). Operators can
override the positive byte limit through the same configuration layers.
Oversized requests return HTTP 413 `M_TOO_LARGE`. Media uploads retain the
separate `media.maxbytes` limit. Report reasons have no separate field cap.

The Turso Complement runtime image, runner and HTTP-only continuity helper are
restored. [complement/BASELINE.md](complement/BASELINE.md) records the
2026-11-06 PST run: 59 failing tests (including parent/subtest entries), with
`TestUnrejectRejectedEvents` passing in its configured settings run. This is
recorded evidence, not an all-green conformance claim. Exclusion rationales
remain in [complement/blacklist.md](complement/blacklist.md).

## Room server ACLs

Current published `m.room.server_acl` state gates inbound room events, typing,
receipts and room-scoped federation reads/membership requests. A denied room
does not block other rooms or non-room device/to-device traffic in a mixed
transaction. Requests and history fetches never contact a denied room peer;
known ACLs also prevent initiating participation when our server is denied.
Events and room EDUs still go to denied peers that remain resident, following
Matrix's delivery recommendation. Room ACLs do not govern media requests.

## Media privacy and caching

Authenticated client download/filename/thumbnail requests fetch foreign MXCs on
demand. The server learns the requested MXC, contacts its origin and possibly
its CDN, and retains the bytes. The origin/CDN normally sees our server's
address, not the user's, but request timing remains observable. Media need not
belong to any joined room. There is no timeline/sync prefetch.

Plain uploads, avatars and thumbnails remain readable to a serving server.
Client-encrypted attachments are cached as ciphertext, never decrypted or
thumbnailed as plaintext. Legacy unauthenticated routes serve local uploads and
their local thumbnails only: they never fetch or expose foreign cache entries.
Authenticated cache hits still obey current federation policy. Federation media
requests require a signature and serve only this server's uploads.

| # | Setting                                                                             | Behavior                                                                                                                                                                                                                           |
| - | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `media.maxbytes`                                                                    | Per upload/download bound, 50 MiB by default. Downloads stream to unpublished disk files.                                                                                                                                          |
| 2 | `media.maxfetches`, `timeoutms`, `maxredirects`                                     | Four active cache fills, a 30-second remote deadline, at most five CDN redirects.                                                                                                                                                  |
| 3 | `media.blocklist`, `allowlist`                                                      | CDN URLs require CA-verified HTTPS. Check every resolved address at every hop; explicitly allow trusted private CIDRs. No client/federation credentials go to the CDN.                                                             |
| 4 | `media.cache.maxbytes`                                                              | Optional total cache cap; 0 means unlimited. Never removes local uploads or room data.                                                                                                                                             |
| 5 | `media.cache.remote` / `media.cache.thumbnail`                                      | Independent `maxagedays`, `unopenedday` and `maxbytes`; each defaults to 0 (off). Enabled conditions combine with OR; size caps evict least-recently-opened entries. Active serving leases are retained.                           |
| 6 | `media.cleanupseconds`                                                              | Cache maintenance interval, 3600 seconds. Cache partials/orphans and missing bytes are reconciled before cache use after restart.                                                                                                  |
| 7 | `media.maxpixels`, `maxdimension`, `thumbnailms`, `thumbnailworkers`, `maxvariants` | 32 million decoded pixels, 10000 pixels per side, five seconds per decoder worker, two active workers, 32 cached/in-progress thumbnail variants per media ID. New variants at the cap return 429; existing variants remain usable. |

PNG/JPEG thumbnails use crop/scale without upscaling and always return static
PNG, including an APNG's default image. Animated generation, video and other
image formats are unsupported. The PNG/JPEG backend is pinned ImageScript
3.20.2 (pure TypeScript, MIT or AGPL-3.0-or-later). Decoder workers are killable;
compressed thumbnail inputs are bounded by the worker count and per-object byte
limit, independently of streamed original downloads. Workers run trusted codec
code with the server's permissions, not untrusted scripts.

Cache cleanup and size limits are all off by default: bytes are kept forever
unless an operator opts in. The dismissable unlimited-storage warning belongs
to the planned admin UI; it is not emitted as a log warning. See the complete
layered settings in `defaults/communico.toml`.

## Notification history

Push rules evaluate live events, including encrypted envelopes, independently of
pusher registration or gateway delivery. `/sync` reports exact room/thread
notification counts. Public/private receipts clear only their applicable scope;
`m.fully_read` alone does not clear notifications. Encrypted mentions hidden in
ciphertext cannot contribute server-side highlights.

Both `/read_markers` and `/receipt/m.fully_read/{eventId}` save the private
fully-read account-data marker; `m.fully_read` does not accept a thread id.
Relations and thread summaries omit redacted relationships, ignored senders and
invisible events, including historical replies. Relation pages support `to` and
three-level `recurse` traversal; thread lists use the latest eligible reply.
Client events bundle reference IDs, the latest valid full replacement event and
thread summaries in `unsigned.m.relations`, including edits/references on the
latest thread reply. Original content is never replaced. Redacting the latest
edit restores the previous valid edit; redacting the original omits its edits.
Local duplicate annotations with the same sender, event type, target and key
return `400 M_DUPLICATE_ANNOTATION` until the earlier annotation is redacted.
Ignored users' ordinary timeline/search messages are hidden without suppressing
state or rewriting stored events.

`GET /_matrix/client/v3/notifications` lists the authenticated account's saved
decisions, newest first, with `from`, `limit` (default 50, maximum 100) and
`only=highlight`. Events use ordinary viewer-aware client rendering; ciphertext
is not decrypted. Redacted or withdrawn entries are not listed.

`[push] readretentiondays` defaults to 30; 0 deletes listing entries as soon as
they are read. Unread entries do not expire. Minimal projection facts remain so
late thread relations can reconcile exact counts and restore newly unread
entries without re-evaluating rules or issuing historical alerts. Retention
runs on startup, periodically and on receipts; listing only filters expired
entries and never deletes them. Zero-day receipt effects commit immediately.
This is separate from event storage and gateway delivery.

## What a push notification reveals

Full-format HTTP pushers receive visible event content, sender and available
room/profile names. Encrypted content remains ciphertext; communico never
decrypts it. A pusher requesting `event_id_only` receives IDs, priority, account
unread count and device routing/custom data, without content, names or tweaks.
Counts-only updates contain no event. See the [E2EE disclosure table](#what-end-to-end-encryption-does-not-hide).
The configured gateway sees this payload; its provider sees what it forwards.
HTTPS does not hide the payload from the gateway.

## HTTP push gateways

Only HTTP pushers are supported; email registrations return a clear unsupported
error. Registration validates but never probes the gateway. Notify URLs require
HTTPS and `/_matrix/push/v1/notify`. `[push] blocklist` and `allowlist` check every
resolved address; private gateways need an explicit allowed CIDR. `cacerts`
adds PEM roots without disabling certificate/name verification. Redirects are
not followed. Requests are limited to 256 KiB, responses to 64 KiB, with a
10-second total request deadline.

Delivery resumes durable saved decisions after restart, independently of
federation enablement. At most eight stable pusher identities run concurrently,
with one request per identity even across registration replacement. Retry delays
use jittered exponential backoff bounded from 1 second to 1 hour.
`[push] deliverygiveuphours` defaults to 24 (0 expires immediately). Expiry stops
delivery attempts, not unread counts or notification history. Delivery is
at-least-once; a crash after acceptance may resend the same event ID.

Read/withdrawn events suppress pending alerts. Badge updates coalesce exact
joined-room/thread notification totals plus pending invites, including explicit
zero to clear badges. Logout, device/token revocation, account deactivation and
matching gateway `rejected` verdicts cancel the corresponding registration's
work. Invalid responses and HTTP/TLS errors retry; they never delete a pusher.

With F2 facades, `append=false` immediately removes matching app ID/pushkey
registrations for other accounts held at that ingress. Home applies the same
cross-account removal when it receives the original registration; its removals
return through each affected selected account's signed stream. An unseen old
pusher can still receive notifications during a partition until that exchange
finishes. Same-account registrations are exempt, and refresh/replay is not a new
replacement request. No unselected account's registration is sent to the facade.

Account deactivation accepts `erase: true`: local readers who gained visibility
only afterward receive room-version-pruned copies, while earlier visibility is
preserved. This is not physical deletion, a federation erasure request or a set
of redaction events. Private account data and stored filters are cleared too.

Room previews support the stable room-summary URL and both historical
`im.nheko.summary` URLs through the same visibility and discovery owner.
Extended profiles advertise `uk.tcpip.msc4133.stable` for older client gates.

Public profiles support namespaced custom JSON fields and `m.tz`, with per-field
GET/PUT/DELETE and `m.profile_fields` capability discovery. Keys are at most 255
UTF-8 bytes; the whole profile must remain below 64 KiB. Custom null values are
retained until DELETE. Only display names and avatars enter room membership.
Avatar and timezone values must be strings but are otherwise accepted verbatim,
matching Synapse's permissive default. Use DELETE to remove an avatar field.

## Facade replication progress

Encrypted key backup is home-owned. F2 facade reads retain selected complete
home version revisions, including their original etags and encrypted sessions;
every backup mutation still requires home ingress, even while home is online.
Reads require a signed backup inventory and the applied domain prefix. Missing
inventory or received-but-unapplied changes are 503, not false missing backups.
Imports never re-run quality selection or allocate versions/etags. Deactivation
cannot restore cleared ciphertext. Changed enrolled versions retain complete
version facts, so replication/storage cost includes that version's ciphertext;
unchanged uploads do not add a fact. Old protected journal facts remain subject
to the deployment's backup/retention protection.

Content reports accepted at either ingress retain immutable node-namespaced
identity and original receive metadata. The home-initiated signed link unions
them without duplicating reports or creating room/sync/federation events. Local
admin pagination numbers are not cross-node identities; `reportId` is. Only
home can resolve a report, including through the private admin socket. Original
home resolution metadata replicates independently and is safe to replay before
its report. Unknown/nonlocal user reports retain the no-disclosure success
response; that response does not imply a stored report or moderation action.

Distributed OpenID credentials retain only digest/expiry facts in the signed
semantic journal. Issuance commits that intent with the credential; imports
preserve its original issuer and expiry, never create client sessions, and
cannot resurrect a deactivated account. Userinfo requires a complete selected
OpenID inventory, independently of password replication or client device
ownership. Missing other-issuer credentials return unavailable until replicated;
known expired credentials remain unknown. Existing home bearers survive bootstrap
unchanged. No bearer is exported.

Distributed stored filters have immutable node/incarnation-namespaced IDs.
Existing home numeric IDs keep their meaning. Filters replicate as protected
per-user semantic facts; a missing foreign ID returns retryable 503 until its
material is held, rather than pretending it is known absent. Filter admission
requires the signed filter inventory and completed received domain prefix.
An older domain bootstrap cannot enable that new scope. Import and retry do
not create account-data news, and deactivation cannot resurrect cleared filters.

Operators can inspect lag over the private admin Unix socket:

```sh
curl --unix-socket /path/to/admin.sock -H 'Content-Type: application/json' \
  -d '{"scopes":["room:!room:example.org","public:@alice:example.org"]}' \
  http://localhost/v1/facade/replication
```

Omit `scopes` to inspect every retained stream. This read-only operation never
exports, wakes workers, allocates source positions or waits for another node.
It returns identifiers and cuts only, not record bodies, credentials, keys or
session data. It is not mounted on public Matrix listeners.

`sources` reports either role's current local room change heads, current local
OOB membership operation heads, and the home's public-account projection revisions.
Membership sources include the current transport `source` and `incarnation`;
retained foreign/history facts are not local authorship. Each capture is local to its owning database, not a
cross-file atomic snapshot. Snapshot cuts allocated only during export (such
as auth and directory) have no local mutation-head entry. A missing source or
stream is unknown, not zero or ready.

`streams` identifies each cut by `peer`, `direction`, `source`, `incarnation`
and `scope`. Each stage contains the journal `sequence`, `hash` and semantic
`sourceCut` (null when that record type has no scalar source watermark).
On outgoing streams, `published` is the locally journaled export, while
`received` and `applied` are the peer's durable acknowledgments. On incoming
streams, they are local receipt, completed scope publication and journal
application respectively. `published` is null while scope publication is not
ready; `ready` never establishes coverage of a later source mutation.
`declaredCut` is the scope watermark in the incoming applied directory, or null
when not declared. Status retains old incarnations for diagnosis; never compare
cuts across identities or confuse a journal sequence with a semantic source cut.

For `membership:@user:server`, semantic cuts cover current-source operations
through the contiguous journal prefix. Interleaved history never advances that
source counter. Readiness uses the actual journal completion under the active
enrollment, not a room scope or a displayed prejoin row. On a facade, membership
`published` additionally covers only the prefix declared by its applied directory;
the directory's `declaredCut` remains a journal position. Pending membership may
refuse new admission with HTTP 503 and the Matrix `errcode`/`error` JSON object;
receipt is not application. Inspection never changes this admission contract.

To observe a home room mutation on a facade, capture its home `sources` cut
after acceptance, then inspect that exact pairing/source/scope until the
incoming ready publication and application source cuts cover it (and the
directory declaration covers it for directory-gated reads). Later work cannot
enlarge the captured target. Home client acknowledgments do not depend on this
inspection or on an online facade.

For a facade room mutation, capture that facade's local `sources` cut and
observe its exact outgoing source/incarnation/scope at home's incoming applied
cut. Reverse room streams have no home directory declaration. A facade S2S
acknowledgment does not wait for an online home; home-client causality follows
observation through home sync, not the timing of another ingress's response.

The private facade status reports `keyRoster.lastHome` as diagnostic contact
time, not authentication, signing authority or a replication acknowledgment.
Authenticated requests never wait for this diagnostic write. Pending times
coalesce by maximum and drain before orderly shutdown closes storage; a
successful drain persists the exact maximum accepted time. An abrupt crash
can lose queued or uncommitted contact observations, with no fixed count
bound. Persistence failures are reported and make shutdown fail; a failed
writer retains its facts but does not restart on later contacts.

## Facade signing-key retirement

A facade signing key is trusted as a key of the whole Matrix server, not as a
restricted delegation. Home publishes the current key roster with every active
key's signature; facades serve that document unchanged. Retirement removes the
key from `verify_keys` and retains its public key and cutoff in `old_verify_keys`
so historical events remain verifiable. Facades do not renew the roster alone.

Revocation at stock peers is prospective and best-effort. In interoperability
testing, tuwunel 1.8.2 accepted a newer event signed only by a retired facade key
even after refetching the retirement document; Synapse 1.156.0 rejected it.
Do not assume that refreshing the key document makes every peer enforce the
cutoff, or that a seven-day refresh bounds acceptance on affected peers.

When retiring or replacing a facade, also revoke its pairing/link credentials
and remove its old public DNS/routing. Provision replacement link credentials
through normal enrollment; do not reuse a compromised node's secrets. These
steps prevent its continued use through your deployment, but cannot force a
remote server to forget a cached key or reject forged, backdated events.

## Backup and restore

Run these commands from the installation directory as the server user, with the
same layered configuration as the server:

```sh
./communico backup /srv/backups/communico-2026-11-14
# Equivalent: deno task backup -- /srv/backups/communico-2026-11-14
```

Backup requires a running home server, not an independently enrolled facade.
The CLI uses only its private admin socket,
never opens live databases, and resolves relative destinations in the caller's
working directory. The destination's parent must exist; the destination must
not exist or overlap live data. The response is JSON with the published path,
backup ID, measured storage-admission pause in milliseconds and encryption mode.
Writes pause for the consistent whole-store cut, then resume while the bundle is
assembled. There is no configured backup duration deadline. Use the completed
bundle, not a copy of live database files or an unfinished private staging tree.

The store prepares and retains every source before the common admission fence,
then pins logical MVCC read snapshots together. SQL export runs after admission
reopens, including for inactive databases and stores larger than the open-file
cache. Each source snapshot defers file checkpoints without blocking ordinary
writers and releases as soon as its export finishes; normal catch-up checkpoints
then resume. This is an online backup, not a pause-free one; `pauseMs` reports
the common cut rather than a configured deadline. It does not include later
file-checkpoint pauses.

The pinned engine's non-experimental checkpoint modes block transactions. After
an export releases its snapshot, a committing writer can therefore pay the
accumulated logical-log checkpoint debt, delaying other sends behind that file's
owner. The measured server catch-up checkpoint took 5.25 seconds on the 43-room
store, processing 23.59 MB of log after 722.81 seconds of snapshot retention;
four slow local sends depended on it. This is an accepted, documented limitation,
not a latency bound: the debt grows with writes during the export. The experimental
PASSIVE database profile is not enabled.

### Measured online-backup cost

On the retained 43-room workload, the final backup window used the integrated
R2/main/performance preview tree `04f783db`; the completed no-backup control used
`ad78332`. The table compares the same clients over 2,190.693 seconds of active
requests, retaining response tails. The backup naturally ran for 2,313.959 seconds.
Runtime, process lifetime and the naturally growing database image were not
identical. All consumers below had zero client errors in both windows. Sync
timings include the clients' unchanged long polls. These are observed
distributions, not latency or throughput guarantees.

| #  | Consumer         | No-backup requests | No-backup p50/p95/max (ms)   | Backup requests | Backup p50/p95/max (ms)      |
| -- | ---------------- | ------------------ | ---------------------------- | --------------- | ---------------------------- |
| 1  | Element Web send | 1208               | 1319/2190/4021               | 939             | 1773/3327/8958               |
| 2  | Alice send       | 1239               | 1345.608/2264.142/3982.816   | 971             | 1672.740/3137.641/6299.815   |
| 3  | Bob send         | 1242               | 1356.333/2237.059/4047.230   | 970             | 1665.370/3251.187/7917.790   |
| 4  | Carol send       | 1237               | 1296.882/2267.258/4003.003   | 974             | 1671.645/3199.387/9115.358   |
| 5  | Dave send        | 1240               | 1355.386/2266.429/3999.759   | 983             | 1657.006/3198.789/7796.032   |
| 6  | Synapse send     | 252                | 8614.398/11822.250/15780.563 | 226             | 9493.243/13807.828/16634.023 |
| 7  | tuwunel send     | 14001              | 3.664/7.174/84.035           | 13832           | 3.636/7.549/109.124          |
| 8  | Element Web sync | 1927               | 1012/1658/33991              | 1454            | 1398/2457/25876              |
| 9  | Alice sync       | 1664               | 1015.654/1640.276/36188.347  | 1289            | 1349.617/2272.299/29834.918  |
| 10 | Bob sync         | 1731               | 982.984/1583.314/29685.903   | 1330            | 1331.672/2236.265/26257.839  |
| 11 | Carol sync       | 1733               | 975.124/1592.511/30584.302   | 1348            | 1324.483/2206.473/26851.968  |
| 12 | Dave sync        | 1750               | 977.817/1597.874/27420.520   | 1324            | 1328.983/2275.370/26731.365  |
| 13 | Synapse sync     | 700                | 2995.044/4521.799/28549.013  | 629             | 3129.740/5082.597/76276.542  |
| 14 | tuwunel sync     | 13948              | 12.507/17.590/157.383        | 13771           | 13.095/18.506/103.950        |

The median/p95 increases are accepted online-backup contention costs. The final
local send maxima were 6.3-9.1 seconds, versus about 4 seconds in the control.
Live per-send attribution identified four handlers dependent on the 5.25-second
catch-up checkpoint above; the other 78 local handlers above the control maximum
had room/projection-owner work or waits without that checkpoint dependency.
The final window is accepted with the documented checkpoint limitation, not as
proof of zero backup cost or a worst-case send-latency guarantee.

The 76.277-second Synapse sync maximum was its first initial sync against stock
Synapse, returning 903 timeline events. During that interval communico completed
191 overlapping sync handlers, all HTTP 200, with a 29.802-second maximum; no
recorded checkpoint overlapped. This attributes the measured maximum to the
stock-peer sync response boundary, not to a communico sync handler. Stock-peer
internal timing and indirect shared-host contention were not isolated.

The loaded backup CLI took 2,313.757 seconds: snapshot/export took 1,647.473
seconds and the remaining audits, media, hashing, fsync, publication and CLI
work took 666.284 seconds. The common fence was 80.973 ms. Snapshot/private
export and immutable database audits dominated; overlapping native timings
cannot be added as exclusive wall-time shares. A separate static export took
135.154 seconds on an earlier 525,185,024-byte cut in another guest; the loaded
cut was 841,687,040 bytes. The static figure times export, not the whole CLI,
and is not a controlled whole-command speed comparison.

Size the service's file-descriptor limit for the complete backup inventory, not
`store.maxopenfiles`: a common cut must retain every room, tenant and the server
file simultaneously, including retired files not yet removed. On the qualified
Linux/Turso build, each newly opened source uses five descriptors (1/10/43 sources
used 5/50/215 additional descriptors). Budget at least `5 * (rooms + tenants + 1)`
for sources alone, plus export targets, HTTP connections, logs and runtime files;
already-open sources share their native owner. Inspect the running process's
`/proc/<pid>/limits` and peak `/proc/<pid>/fd` count under normal traffic and a
backup, and set the supervisor's `LimitNOFILE` or launch-shell `ulimit -n`
accordingly. `maxopenfiles` only sizes the ordinary idle cache, not this cut.

The format-1 bundle includes database files, signing private keys, password
hashes, uploaded local media, effective configuration, the original operator
overlay and referenced TLS/CA files. Payloads and manifest are mode 0600 in
private directories; the manifest is published last and records exact hashes
and sizes. Remote media cache, thumbnails, unfinished uploads, runtime sockets
and the backup passphrase source are excluded. Environment TURN credentials
remain external and must be supplied on the restored installation.

Configured facade link certificate/key/CA files and a present pairing bootstrap
are portable too. Deployment inputs are captured before the database cut, so a
bootstrap consumed by later durable enrollment is retained. An already-consumed
or missing pairing file is valid; durable enrollment no longer needs it.
Protected link keys, pairing inputs and passphrase inputs must retain the
existing server-user/private-mode ownership policy. Replacing a paired link's
TLS identity requires its normal re-enrollment flow.

`backup.encrypt` defaults to false. To use standard OpenPGP AES256 encryption,
install GnuPG (`gpg` and `gpgconf`) for the server and set:

```toml
[backup]
encrypt = true
passphrasefile = "/srv/secrets/communico-backup-passphrase"
```

The passphrase file must be owned by the server user and inaccessible to group
and others. Keep it separately from the archive; restore needs the same
passphrase through its own configuration. The manifest remains readable and
contains identifiers and operational metadata. Encryption does not securely
erase plaintext staging from the filesystem. Protect and copy the complete
bundle off-machine with your own scheduling/storage tools.

Restore is explicit and offline. Stop and fence the original installation
before serving another copy of the same Matrix identity, including on another
machine. Configure the desired `store.dir` and `media.root` on the target, then:

```sh
COMMUNICO_CONFIG=/srv/communico/config/restore.toml \
  ./communico restore /srv/backups/communico-2026-11-14
# Equivalent: deno task restore -- <bundle> [--replace]
```

Target parents must be writable by the server user; missing parents are created
where permitted. Restore verifies the exact bundle, supported
native/schema versions and application references, then migrates private copies,
audits media and signing identity, sanitizes consuming keys and sync delivery
boundaries, and writes a durable operator report before promotion. The archive
is never modified. Nonempty targets refuse unless `--replace` is explicit;
replacement preserves prior store and media roots and prints their paths.
Neither replacement nor a stale socket bypasses a running owner's store lock.
An interrupted two-root promotion fences startup; rerun the offline command to
recover the original pair before retrying. Do not manually combine roots.

The JSON result names `configPath`, `reportPath` and retained replacement paths.
Read the report, supply any external secrets, and start with the generated config:

```sh
COMMUNICO_CONFIG=<configPath> ./communico start
```

The generated configuration retains the Matrix server name/signing identity,
uses the target storage/native/admin paths and portable bundled TLS/CA paths,
and respects explicit target config/environment overrides. Normal startup is
never an automatic restore and refuses a missing or modified required report.
After that durable report boundary, retained delayed, push and federation work
resumes with normal semantics; there is no additional approval flag.

An older archive cannot recover post-cut messages, credentials/revocations,
cancellations, peer acknowledgments or client private keys. Old credentials and
jobs may revive; external side effects may repeat. Restored OTK/fallback pools
are cleared so clients can refill them. The server reports an explicit empty
unused-fallback list, but retained clients may wait for their normal rotation:
matrix-sdk-crypto 0.19.1 replaces an existing fallback only once it is 7 days old.
Fallback keys are used only when one-time keys run out; devices can refill OTKs
while their server fallback pool remains empty until client rotation. Archived
fallback keys are never republished because they may already have been used.
Do not reset client crypto stores or change clocks to force rotation.
Ordinary sync receives a fresh recovery
identity, sliding positions expire, and peers receive device-list resnapshot
resets. Keep clients' crypto stores. These mechanisms do not reconstruct lost
private keys. Ordinary recovery sends admitted restored state at an empty,
limited timeline boundary; archived history remains available by pagination.
Clients can still display rooms created after the cut and account-data types
first written after it: the archive cannot name those objects to remove them
from newer caches. Before optional signout, have clients securely preserve their
private crypto stores and recovery secrets; the server cannot export those stores.
An operator can then optionally use existing device/token
revocation to sign users out so clients drop these caches on next login. This
is never automatic.
The report records sanitation, pending work and these security/RPO implications.

For enrolled deployments, the private report also inventories facade control
revisions, received/applied and acknowledged journal cuts, retained record and
mailbox identities, frozen egress digests, membership results and causal
frontier/conflict identities. Tenant inventories include device-operation
histories, key-consumption tombstones, routed to-device targets (including ACKed
and cancelled targets), inbox/ACK cuts, link-application receipts and profile
fanout progress. Payloads, credentials, signing keys and dispatch/ACK secrets are
not copied into this inventory. It is an inspection of the captured local cut,
not proof that a surviving node has reconciled its newer suffix or permission to
reassign an owner. A facade journal cannot replace a coherent home backup or
recover data absent from every surviving copy.

## Operator tools

The tools require the server to be running with the same configuration. They
use HTTP/JSON over its private Unix socket, never open store files and never
load the native library. The admin API is separate from the public listeners.

`[admin] socket` (or `COMMUNICO_ADMIN_SOCKET`) overrides the socket path. The
default empty value resolves to `admin.sock` beside the store root, for example
`/srv/communico/admin.sock` for `/srv/communico/store`. Its parent must exist and
belong to the server user; the socket is created mode 0600 and removed on clean
shutdown. Run tools as that same user.

| # | Task                                 | Operations                                                                                                   |
| - | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1 | `deno task federation-block -- ...`  | `add <glob> [--note <text>]`, `remove <glob>`, `list`                                                        |
| 2 | `deno task federation-peer -- ...`   | `add`, `remove`, `list`, `pending`, `approve`, `reject [--block]`; invoke without arguments for full grammar |
| 3 | `deno task federation-key -- ...`    | `list [<name>]`, `forget <name>`, `accept <name>`                                                            |
| 4 | `deno task federation-outbox -- ...` | `list [<destination>]`, `retry <destination>`, `prune <destination>`                                         |
| 5 | `deno task federation-cert`          | Write the configured certificate/key from the tenant identity; refuse existing outputs                       |
| 6 | `deno task rooms -- ...`             | `list [--purgeable]`, `purge [--older-than <ms>]`, `drop <roomId>`                                           |
| 7 | `deno task backup -- <destination>`  | Publish a whole-server bundle through the running owner; see Backup and restore                              |

The shared launcher grants read/env access, write access to the socket, and
`--allow-net=unix:<config-resolved-absolute-socket-path>`, which Deno requires
even for local IPC. It grants no TCP/DNS access or FFI permission. Socket paths
containing commas or newlines cannot be represented by this Deno permission
allowlist and are rejected before launching a tool.

For initial certificate generation, start with federation disabled, run
`deno task federation-cert`, then restart with federation enabled. A generated
certificate takes effect on the next start. The private key is mode 0600.

Room listings show `stay <id>` or `archived`. Outbox listings use composite
`#<room>:<pos>` PDU ids and composite reject-invite ids, with in-flight transaction
ids shown only while the running sender owns the request. PDU expiry is derived
from its queued timestamp and configured lifespan; reject-invite jobs have no
expiry in the current core. CLI punctuation uses ASCII.

### Facade storage pressure

On the admin socket, `GET /v1/facade/status` reports capacity per filesystem.
If the filesystem runs out of space during a checkpoint, WAL blocks can remain
allocated. Status reports `filesystemFull` and `checkpoint.retainedWalBytes`;
those bytes count as protected until a scheduled retry succeeds. Cache eviction
can make room for the retry. A completely full filesystem can prevent a cold
restart from opening the database. Free space on the affected filesystem before
retrying the restart; do not delete database or WAL files. Confirmed data is
not lost.

Native temporary files live in `.scratch` under the facade store.
`capacity.scratch.currentBytes` and `capacity.scratch.observedPeakBytes` are
sampled at statement completion, checkpoint, and status reads. The observed
peak can miss a spill created and removed within one native call. Scratch is
not fenced: it can use physical space reserved for another write. If that
fills the filesystem, the affected write fails with a retryable storage error;
retry once space is available. Confirmed data is not lost.

### Content reports

Authenticated clients can report events in rooms they are currently joined to,
rooms without joining them, and local users without sharing a room. Event reports
accept optional `reason` and integer `score`; room/user reports require a string
`reason` (empty is allowed). Unknown/nonlocal user reports return success without
revealing whether an account exists. Reports do not automatically redact, ban or
send anything to other servers, and never copy event content or decrypt messages.

Reports are durable server data, available only through the private admin socket:

```sh
curl --unix-socket /srv/communico/admin.sock -H 'Content-Type: application/json' \
  -d '{"status":"open","limit":100}' http://localhost/v1/reports/list
curl --unix-socket /srv/communico/admin.sock -H 'Content-Type: application/json' \
  -d '{"id":1,"resolution":"Reviewed"}' http://localhost/v1/reports/resolve
```

List accepts `kind` (`event`, `room`, `user`), `status` (`open`, `resolved`),
`limit` (1-1000) and `from` (the prior page's numeric `next`). With no filters it
lists all reports, oldest first. Resolution is idempotent: the first resolution
and its timestamp are retained. Reports are not deleted on resolution.
Admin UI: TODO.

### Recovering facade conflict values

F2 keeps losing complete account-data, push-rules and profile revisions. A
runtime operator can inspect one semantic key on the private admin Unix socket;
this is not a Matrix endpoint and does not require the home link to be online.
Inspection returns operation identities, hashes, concurrent/superseded state
and the number of pending operations, never the values. Generic status does not
include them. Pending values with missing predecessor history are not exported
as complete alternatives.

```sh
curl --unix-socket /srv/communico/admin.sock -H 'Content-Type: application/json' \
  -d '{"kind":"account-data","localpart":"alice","roomId":"","type":"m.secret_storage.key.example"}' \
  http://localhost/v1/facade/conflicts
```

Use `kind:"profile"` or `kind:"push-rules"` with `localpart` for the other
complete registers. Select an `operationId` from `alternatives`, then POST the
same selector plus `operationId` and an absolute `exportfile` path to
`/v1/facade/conflicts/export`. The server creates a runtime-owned mode-0600 file
containing `{selector,operation}`; `operation.payload` is the stored opaque
JSON string after parsing and reserialization, not the original wire bytes.
Key order can change and large integer literals can be rounded during parsing.
Existing files and symlinks are never overwritten. The response
contains only the selected identity and path. Treat the file as private account
data, even when its contents are encrypted; do not put its contents in logs.

Export does not change the winner, stream cuts or operation history. Give the
selected value to the account owner through a private channel. They recover it
using ordinary authenticated account-data PUTs, profile field writes, or the
push-rules APIs, preserving any desired complete rule order. Those writes
validate normally and create new causal operations observing the held history;
the operator does not replace rows or reimport an old operation as a new write.
`m.tag` inspection is retained put/remove/reset history, labeled `retained`, not
a losing complete tag map; reconstruct the desired tags and use an ordinary
`m.tag` PUT. A deactivated account cannot use recovery to regain write authority.

## Server lifecycle

SIGTERM and SIGINT stop admission on all listeners. Admitted handlers and
response bodies have `[server] shutdowngraceseconds` (default 10) to finish.
New requests receive 503 or a refused connection. At the deadline remaining
transports are aborted and their per-listener counts are logged. The store
closes after the listeners. A clean drain exits 0; forced aborts exit non-zero.
Admin socket paths are limited to 107 UTF-8 bytes after absolute resolution.

Unhandled promise rejections are fatal. The server logs
`fatal: unhandled rejection` and the reason/stack, immediately stops serving,
and allows at most two seconds for store cleanup before exiting non-zero.
A second unhandled rejection exits immediately. Run the server under a
supervisor that restarts failed processes, for example:

```ini
[Unit]
Description=Communico Matrix homeserver
After=network.target

[Service]
User=communico
WorkingDirectory=/srv/communico
ExecStart=/usr/bin/deno task start
Restart=on-failure
RestartSec=2
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```
