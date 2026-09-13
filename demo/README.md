# communico — Matrix homeserver on Doltgres (demo)

A prototype Matrix homeserver where **a room is a Doltgres database, an
event is a commit, and forward extremities are branches** — plus the
proof that real, unmodified Matrix clients can use it.

Prerequisites: **Docker only** (the client runs as its official image;
the server runs in its dev container).

## Quickstart

```bash
git clone <this repo> && cd communico
bash demo/setup.sh        # builds, boots Doltgres+server, creates the room, logs in both demo users
bash demo/run-demo.sh     # prints the 3-terminal choreography (or: --check for a headless self-test)
```

`demo/setup.sh` prints the room id and the exact copy-paste commands for
both acts. `bash demo/run-demo.sh --check` sends via one
matrix-commander container and greps the listening one for the message
and its `\$<43 chars>` event id.

## What you are looking at

The homeserver's storage engine IS the version-controlled database. When
matrix-commander (unmodified, from Docker Hub, matrix-nio SDK) sends a
message, the homeserver writes it as a Dolt commit in the room's
database; `dolt.log` on that database literally reads as the
conversation. The event id every client displays is a **content hash of
the event itself** (Matrix reference-hash style, 43 base64url chars) —
canonical for every room, verifiable by recomputation, stable across
stores and engines. The Dolt commit hash is the server's per-store
receipt for the event; the explicit bijection lives in `event_index`.

**Historical recording (three-party, browser peer parked)** — the gif
below predates the lite hat's parking: two unmodified matrix-commander
clients plus a third voice that was a browser peer joining through the
server's lite hat (msync over WebSocket), byte-identical content-hash
event ids on both sides of the engine boundary. The browser-peer code is
parked — prior art on `research/lite`, plan in
`~/Documents/communico/plans/lite/`:

![three-party demo recording (browser peer parked, see plans/lite):
alice and bob on matrix-commander, carol the browser peer — one room,
one id space, watched in dolt.log](communico-demo-3p.gif)

The two-party original (`communico-demo.gif` / `.cast`) is the demo this
branch runs today.

Because state lives in commits, things homeservers hand-build are native
here: room state at any event is `SELECT * FROM state AS OF '<commit>'`,
a state delta is `dolt_diff(a, b)`, forward extremities are
`dolt.branches`, and a second homeserver joining a room is a
`dolt pull` of the room's repository.

Next: `demo/inspection-tour.md` (eight queries against your own fresh
data), then the engineering notes and gap report in
`spikes/RESULTS.md` (`## Gap report — Dolt-as-is vs a Dolt-native Matrix
homeserver`).
