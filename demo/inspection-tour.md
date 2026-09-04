# Inspection tour — a Matrix room as a Dolt repository

Eight stops, each with the query and how to run it. Nothing here uses ids
from our runs: each stop tells you how to pull the value out of YOUR data.

**How to run the queries:** any Postgres client against
`localhost:5432` (user `root`, password `secret`) — or, with zero
installs, a Deno one-liner inside the container, for example:

```bash
docker exec communico-dev bash -c "cd /workspace && deno eval \"
  import pgpkg from 'pg';
  const c = new pgpkg.Client({host:'127.0.0.1',port:5432,user:'root',password:'secret',database:'postgres'});
  await c.connect();
  console.log((await c.query('SELECT room_id, db_name FROM room_directory;')).rows);
  await c.end();\""
```

Swap the `database:` and the SQL per stop. Setup assumed: you ran
`demo/setup.sh` and at least Act 1 (ideally Act 2 with a couple of
messages).

## Stop 0 — find the room's database

Every room is its own Doltgres database. The directory lives in the
server DB:

```sql
SELECT room_id, db_name, room_version FROM room_directory;
```

Pick your demo room's `db_name` (`room_…`) and use it as the database in
the next stops.

## Stop 1 — the conversation is a commit log

On the room DB (first hop onto the extremity branch — fresh connections
land on `main`, which only holds genesis commits):

```sql
SELECT name FROM dolt.branches WHERE name LIKE 'x%';       -- the extremity branch
SELECT DOLT_CHECKOUT('<that branch>');
SELECT commit_hash, date, message FROM dolt.log;
```

One commit per Matrix event, in order. The commit message names the
event type (`event … type m.room.message`).

## Stop 2 — event ids are content hashes; commit hashes are receipts

The event id the Matrix client shows is a content hash of the event
itself (Matrix reference-hash style, `$<43 base64url chars>`) —
canonical for every room, whatever the room version. The Dolt commit
hash is the server's per-store receipt: it proves the event landed as a
commit, but never appears on the wire. The server's `event_index` (in
the server DB) is the explicit bijection:

```sql
SELECT event_id, commit_hash, seq FROM event_index
 WHERE room_id = '<your room id>' ORDER BY seq;
```

## Stop 3 — extremities are branches

```sql
SELECT name, hash FROM dolt.branches;
```

After a linear run of sends there is exactly one `x…` branch: the room's
single forward extremity. Matrix's extremity set and Dolt's branch set
are the same data.

## Stop 4 — state at any moment (no state-groups machinery)

```sql
SELECT * FROM state AS OF '<any commit hash from stop 1>';
```

Full room state as of that commit — Prolly-tree snapshots with
structural sharing, the thing Synapse hand-builds state groups for.
Try the oldest hash and the newest: same query, two moments.

## Stop 5 — what changed between two moments

```sql
SELECT * FROM dolt_diff('<older commit>', '<newer commit>', 'events');
SELECT * FROM dolt_diff_stat('<older commit>', '<newer commit>', 'events');
```

Row-level and summary diffs between any two commits — Matrix's
"state delta between events" is a native operation here.

## Stop 6 — a real fork + merge (2 parents, our resolution)

Create the fork (inside the container):

```bash
docker exec communico-dev bash -c \
  "cd /workspace && deno run --env --allow-net --allow-env --allow-read demo/fork-demo.ts '<your room id>'"
```

It ingests E2a (`topic: cats`) and E2b (`topic: dogs`) with the same
prev, then E3 with both prevs. Now:

```sql
SELECT parent_hash FROM dolt.commit_ancestors
 WHERE commit_hash = (SELECT HASHOF('<extremity branch>'));
```

Two rows: the merge commit has exactly two parents. Note the
scalar-subquery form `(SELECT HASHOF(...))` — bare `= HASHOF(...)` errors
on merge tips (gap item 3 in `spikes/RESULTS.md`). And the topic that
survived is `dogs` — resolved by the homeserver's merge driver
(latest-wins), not by Dolt's cell merge:

```sql
SELECT * FROM state WHERE type = 'm.room.topic';
```

## Stop 7 — the D6 mechanism: why merges need a session variable

Open `api/engine/mergedriver.ts` (or `spikes/RESULTS.md`, blocker B1).
Doltgres cannot hold an unresolved-conflict merge across statements in
autocommit mode — the merge errors and rolls back. The engine runs
`SET dolt_allow_commit_conflicts = 1;` right after connecting, so
`DOLT_MERGE` returns `("",0,1,"conflicts found")` and holds the conflict
state in-session; the driver then resolves it and commits the merge
commit with OUR content. All inside one dedicated connection — the held
state dies at disconnect.

## Stop 8 — federation is a pull

The two-instance replication from the room-engine plan, replayable here:
a second Doltgres (port 5433) + app (ports 8080/8081) runs in the same
container when the room-engine demo ran it; `pushRoom` pushes the room's
`main` + `x*` branches to a `file:///tmp/communico-remotes/<db>` remote,
and the second instance `dolt pull`s it — the exact commands and the
transcript are in `spikes/RESULTS.md` under `## Phase 3 log`. The
takeaway: remote homeserver = Dolt remote; room join = clone; sync =
pull.

---

When you're done: the engineering notes behind this demo — spikes,
capability matrix, blockers (D6/D7/D8/Q4), and the full gap report —
live in `spikes/RESULTS.md`, section `## Gap report — Dolt-as-is vs a
Dolt-native Matrix homeserver`.
