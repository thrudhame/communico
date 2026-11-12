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

`/sync?use_state_after=true` returns state at the response's timeline end in
`state_after` (also when empty), not `state`. The default retains the legacy
state-before-timeline contract. Filters and lazy member loading apply to both.

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
except redactions and the standard in-room key-verification exchange. State
remains plaintext. Local encryption downgrade/redaction is blocked while
unencrypted creation is disabled; remote events retain normal Matrix validity.

Administrators control three independent settings in `[encryption]`:

| # | Config name                           | Default | Effect when false                                                                                                          |
| - | ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1 | `encryption.allowunencryptedcreation` | `false` | Insert Megolm at room creation and protect local encryption state from downgrade/removal                                   |
| 2 | `encryption.allowunencryptedjoining`  | `true`  | Refuse local joins/knocks to known plaintext rooms; leave unknown remote plaintext rooms after joining and return an error |
| 3 | `encryption.allowunencryptedmessages` | `false` | Refuse local plaintext non-state events in encrypted rooms, with the exceptions above                                      |

Environment overrides are `COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDCREATION`,
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDJOINING` and
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDMESSAGES`. Strict remote join refusal
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

| #  | Limit    | Not hidden by room E2EE                                                                                                                                       | Visible to whom                                                                                                                                                                                         | Matrix spec                                                                           |
| -- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1  | Protocol | All room state: name, topic, avatar, members and membership changes, join rules, power levels, history visibility, aliases, and the encryption setting itself | Our server and room servers; permitted readers. Invites/knocks can expose selected state before joining.                                                                                                | [State][e2ee-state], [stripped state][e2ee-stripped]                                  |
| 2  | Protocol | Space metadata and room hierarchy (`m.space.child`, `m.space.parent`)                                                                                         | Our server and room servers; users allowed to discover the hierarchy. Spaces hold state, which Matrix does not encrypt.                                                                                 | [Spaces][e2ee-spaces], [no encrypted state][e2ee-no-state]                            |
| 3  | Protocol | Event sender, room ID, timestamps, event IDs, ciphertext size, encryption algorithm and session ID; device/sender-key fields when present                     | Our server, room servers and permitted readers. Size means encrypted event size, not exact plaintext length.                                                                                            | [Event format][e2ee-events], [Megolm][e2ee-megolm]                                    |
| 4  | Protocol | `m.relates_to`: reply, thread, edit and reaction targets, relationship types, and reaction keys (such as emoji)                                               | Our server, room servers and permitted readers                                                                                                                                                          | [Relationships][e2ee-relations], [reactions][e2ee-reactions]                          |
| 5  | Protocol | Redaction targets (`redacts`) and any redaction reason                                                                                                        | Our server, room servers and permitted readers                                                                                                                                                          | [Redactions][e2ee-redactions]                                                         |
| 6  | Protocol | Typing notifications and public read receipts, including event/thread IDs and receipt timestamps                                                              | Our server, room servers and room members. Private read receipts stay with our server and the sending user; they are not E2EE.                                                                          | [Typing][e2ee-typing], [receipts][e2ee-receipts]                                      |
| 7  | Protocol | Presence, last-active information and status messages, when sent                                                                                              | Our server; interested remote servers and users sharing rooms                                                                                                                                           | [Presence][e2ee-presence]                                                             |
| 8  | Protocol | User profiles: display names, avatars and other published profile fields                                                                                      | Our server; remote servers and users permitted to query them. Room membership also carries display names and avatars.                                                                                   | [Profiles][e2ee-profiles]                                                             |
| 9  | Mixed    | Account data (except values clients separately encrypt, such as secret storage); push rules                                                                   | Our server and your own clients, not other room members merely because they share a room                                                                                                                | [Account data][e2ee-account], [push rules][e2ee-push], [secret storage][e2ee-secrets] |
| 10 | Protocol | Device lists, device names, public device/cross-signing keys and published one-time/fallback keys                                                             | Our server; querying clients and remote servers receiving key/device information. Private keys are not published.                                                                                       | [Key distribution][e2ee-keys], [device federation][e2ee-devices]                      |
| 11 | Mixed    | To-device message contents unless the client Olm-encrypts them; sender, destination users/devices and routing type remain visible either way                  | Sending and receiving homeservers; the destination devices                                                                                                                                              | [To-device][e2ee-to-device], [Olm][e2ee-olm]                                          |
| 12 | Client   | URLs requested through server-side URL previews                                                                                                               | Our server learns the URL, even if it came from an encrypted message                                                                                                                                    | [URL preview privacy][e2ee-previews]                                                  |
| 13 | Mixed    | Media and thumbnails uploaded without client-side attachment encryption; avatars and image packs have no standard encryption mechanism                        | Uploading/serving servers and users able to retrieve the media. Encrypting the message alone does not encrypt its files; thumbnails need separate encryption too.                                       | [Attachments][e2ee-attachments], [media][e2ee-media], [image packs][e2ee-no-state]    |
| 14 | Protocol | Published room-directory entries: room IDs, names, topics, aliases, avatars and member counts                                                                 | The publishing server and anyone allowed to query its directory, without joining the listed room                                                                                                        | [Room directory][e2ee-directory]                                                      |
| 15 | Protocol | Push-notification routing and metadata sent to a push gateway                                                                                                 | Our server and the configured gateway; the provider sees what the gateway forwards. The notification format determines which fields are sent.                                                           | [Push notifications][e2ee-push]                                                       |
| 16 | Protocol | Connection IPs, request timing and traffic sizes                                                                                                              | The servers you connect to and network observers (their view depends on transport/proxies). Room E2EE provides no traffic anonymity; it does not automatically give remote room servers your client IP. | [HTTP transport][e2ee-transport], [connection records][e2ee-connections]              |

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
shipped defaults and all eight control combinations.

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

Account deactivation accepts `erase: true`: local readers who gained visibility
only afterward receive room-version-pruned copies, while earlier visibility is
preserved. This is not physical deletion, a federation erasure request or a set
of redaction events. Private account data and stored filters are cleared too.

Public profiles support namespaced custom JSON fields and `m.tz`, with per-field
GET/PUT/DELETE and `m.profile_fields` capability discovery. Keys are at most 255
UTF-8 bytes; the whole profile must remain below 64 KiB. Custom null values are
retained until DELETE. Only display names and avatars enter room membership.
Avatar and timezone values must be strings but are otherwise accepted verbatim,
matching Synapse's permissive default. Use DELETE to remove an avatar field.

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
