# communico

A Matrix homeserver rebuilding its core on Turso.

The running server owns its Turso store. Start it with `deno task start` after
building the native library in the project test environment.

The former Doltgres implementation and its integration tests remain on
`doltgres` at `2d3944abaed7571fd8fe24a532860bd134a46d15`.

## Checks

Run inside the authorized project test VM:

- `deno task check`
- `deno task test`
- `sh hooks/pre-commit`

Configuration uses `defaults/communico.toml`, an optional
`config/communico.toml` overlay and `COMMUNICO_*` environment overrides.
`deno task config` prints the merged settings; it does not initialize storage.

The Complement runner, blacklist and historical baseline are retained for
restoration. Its runtime image and continuity query helpers must be rebuilt
before the harness can run on this branch.

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
