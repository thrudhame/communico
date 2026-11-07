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
choose its storage engine. E2EE is core product scope: its server APIs and
room-encryption controls are being designed, not implemented in this snapshot.
The old browser demo's E2EE exclusion was scoped to that demo.

## Checks

Run inside the named, authorized project test VM or dedicated project LXC on
agora specified by the execution plan:

- `deno task check`
- `deno task test`
- `sh hooks/pre-commit`

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
