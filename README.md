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

| # | Config name                           | Default | Effect when false                                                                                                         |
| - | ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1 | `encryption.allowunencryptedcreation` | `false` | Insert Megolm at room creation and protect local encryption state from downgrade/removal                                  |
| 2 | `encryption.allowunencryptedjoining`  | `true`  | Refuse local joins to known plaintext rooms; leave unknown remote plaintext rooms after the handshake and return an error |
| 3 | `encryption.allowunencryptedmessages` | `false` | Refuse local plaintext non-state events in encrypted rooms, with the exceptions above                                     |

Environment overrides are `COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDCREATION`,
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDJOINING` and
`COMMUNICO_ENCRYPTION_ALLOWUNENCRYPTEDMESSAGES`. Strict remote join refusal
may briefly join before discovering the room's authoritative encryption state.
Interrupted cleanup remains durable and visible in federation-outbox review;
it retries through the federation sender. Existing members are not evicted.
The three `io.element.e2ee_forced.*` `/versions` flags reflect creation policy.

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

The Turso Complement runtime image, runner and HTTP-only continuity helper are
restored. [complement/BASELINE.md](complement/BASELINE.md) records the
2026-11-06 PST run: 59 failing tests (including parent/subtest entries), with
`TestUnrejectRejectedEvents` passing in its configured settings run. This is
recorded evidence, not an all-green conformance claim. Exclusion rationales
remain in [complement/blacklist.md](complement/blacklist.md).

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
