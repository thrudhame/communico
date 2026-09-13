#!/usr/bin/env bash
# demo/run-demo.sh — choreography helper.
#   (default)   interactive: prints the three-terminal choreography with
#               real values filled in
#   --check     headless Act 1 + Act 2 self-test; exit 0/1
#   --scripted  tmux 3-pane paced run for asciinema recording
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
CONTAINER=communico-dev
MC_IMAGE=matrixcommander/matrix-commander

die_unless_up() {
  docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || { echo "$CONTAINER not running — run demo/setup.sh first" >&2; exit 1; }
}

room_id() {
  docker exec "$CONTAINER" bash -c \
    "cd /workspace && deno eval \"
      import pgpkg from 'pg';
      const c = new pgpkg.Client({host:Deno.env.get('DB_HOST'),port:Number(Deno.env.get('DB_PORT')),user:Deno.env.get('DB_USER'),password:Deno.env.get('DB_PASS'),database:'postgres'});
      await c.connect();
      const r = await c.query(\\\"SELECT room_id FROM event_index WHERE room_id IN (SELECT room_id FROM room_directory WHERE room_version='11') GROUP BY room_id ORDER BY MAX(seq) DESC LIMIT 1;\\\");
      if (r.rows.length) console.log(r.rows[0].room_id);
      await c.end();
    \" 2>/dev/null | tail -1"
}

mc() {
  local store=$1; shift
  docker run --rm --network "container:$CONTAINER" \
    -v "$store:/data:z" -w /data "$MC_IMAGE" "$@" \
    --store /data/store --credentials /data/credentials.json
}

MODE="${1:-interactive}"
die_unless_up
ROOM_ID="$(room_id)"
[[ -n "$ROOM_ID" ]] || { echo "no demo room found — run demo/setup.sh" >&2; exit 1; }

case "$MODE" in
  interactive)
    cat <<EOF
Three-terminal choreography (room: $ROOM_ID):

TERMINAL 1 — alice listens (matrix-commander, unmodified image):
  docker run --rm -it --network container:$CONTAINER -v /tmp/mc-alice:/data:z -w /data \\
    $MC_IMAGE --listen forever --plain \\
    --store /data/store --credentials /data/credentials.json

TERMINAL 2 — bob sends (as many as you like):
  docker run --rm --network container:$CONTAINER -v /tmp/mc-bob-send:/data:z -w /data \\
    $MC_IMAGE -m "hello alice via doltgres" --room '$ROOM_ID' --plain \\
    --store /data/store --credentials /data/credentials.json

TERMINAL 3 — watch the conversation become commits (every 2 s):
  watch -n2 "docker exec $CONTAINER bash -c 'cd /workspace && deno eval \"
    import pgpkg from \\\"pg\\\";
    const root = new pgpkg.Client({host:Deno.env.get(\\"DB_HOST\\"),port:Number(Deno.env.get(\\"DB_PORT\\")),user:Deno.env.get(\\"DB_USER\\"),password:Deno.env.get(\\"DB_PASS\\"),database:\\"postgres\\"});
    await root.connect();
    const db = (await root.query(\\\"SELECT db_name FROM room_directory WHERE room_id=\\\\\\\"$ROOM_ID\\\\\\\"\\\")).rows[0].db_name;
    await root.end();
    const c = new pgpkg.Client({host:Deno.env.get(\\"DB_HOST\\"),port:Number(Deno.env.get(\\"DB_PORT\\")),user:Deno.env.get(\\"DB_USER\\"),password:Deno.env.get(\\"DB_PASS\\"),database:db});
    await c.connect();
    const xb = (await c.query(\\\"SELECT name FROM dolt.branches WHERE name LIKE \\\\\\\"x%\\\\\\\" LIMIT 1;\\\")).rows[0].name;
    await c.query(\\\"SELECT DOLT_CHECKOUT(\\\\\\\"\\\"+xb+\\\"\\\\\\\");\\\");
    console.log((await c.query(\\\"SELECT message FROM dolt.log LIMIT 5;\\\")).rows.map(r=>r.message).join(\\\"\\\\n\\\"));
    await c.end();
  \"'"

Each send prints an event id of the form \$<43 chars> — a content hash
of the event itself (Matrix reference-hash style, base64url). The id is
canonical for every room; the Dolt commit hash is the server's per-store
receipt for it (see event_index).

EOF
    ;;

  --check)
    BODY="check-$(date +%s)-$RANDOM"
    echo ">> Act 1: bob sends '$BODY'"
    mc /tmp/mc-bob-send -m "$BODY" --room "$ROOM_ID" --plain
    echo ">> Act 2: alice listens once"
    # --output json: the event id only appears in debug/json output, and
    # the check greps for it (\$<43 chars> == content-hash event id)
    OUT="$(mc /tmp/mc-alice --listen once --plain --output json 2>&1 || true)"
    PASS=1
    if grep -q "$BODY" <<<"$OUT"; then
      echo "   body found in alice's output ✓"
    else
      echo "   BODY NOT FOUND in alice's output" >&2; PASS=0
    fi
    if grep -qE '\$[A-Za-z0-9_-]{43}' <<<"$OUT"; then
      echo "   event id '\$<43 chars>' (content-hash id) found ✓"
    else
      echo "   no \$<43 chars> event id in alice's output" >&2; PASS=0
    fi

    if [[ $PASS == 1 ]]; then echo "CHECK: PASS"; else echo "CHECK: FAIL" >&2; exit 1; fi
    ;;

  --scripted)
    # Q5/A: host-side tmux (the container has no docker CLI/socket, so
    # container-side tmux cannot run the matrix-commander panes). The
    # recorder attaches with: tmux attach -t communico-demo
    # Geometry 140x40: sized for regular laptop fullscreen terminals
    # (~142 cols); a cast is not a video — it needs the viewer's cols.
    command -v tmux >/dev/null || { echo "tmux not found on host" >&2; exit 1; }
    SESSION=communico-demo
    tmux kill-session -t "$SESSION" 2>/dev/null || true

    # helper: the watch pane's query, as a real deno script (env-driven —
    # no shell-escaping games); piped into the container via stdin
    cat > /tmp/demo-watch.ts <<'TS'
import pgpkg from 'pg';
const roomId = Deno.env.get('DEMO_ROOM_ID')!;
const cfg = { host: Deno.env.get('DB_HOST')!, port: Number(Deno.env.get('DB_PORT')), user: Deno.env.get('DB_USER')!, password: Deno.env.get('DB_PASS')! };
const root = new pgpkg.Client({ ...cfg, database: 'postgres' });
await root.connect();
const db = (await root.query('SELECT db_name FROM room_directory WHERE room_id = $1', [roomId])).rows[0].db_name;
await root.end();
const c = new pgpkg.Client({ ...cfg, database: db });
await c.connect();
const xb = (await c.query(`SELECT name FROM dolt.branches WHERE name LIKE 'x%' LIMIT 1;`)).rows[0].name;
await c.query(`SELECT DOLT_CHECKOUT('${xb}');`);
console.clear();
console.log('room database ' + db + ' — dolt.log (newest first)');
const rows = (await c.query('SELECT commit_hash, message FROM dolt.log LIMIT 8;')).rows;
console.log(rows.map((r: { commit_hash: string; message: string }) =>
  '  ' + r.commit_hash.slice(0, 8) + '  ' + r.message).join('\n'));
// §13.2.3: the reveal — re-rendered every cycle once its time has come
// (the pane's console.clear would erase any one-shot print)
if (Date.now() >= Number(Deno.env.get('DEMO_WATCH_T0') ?? 0) + 58_000) {
  console.log();
  console.log('-- six messages, six commits, two clients — real sends landing as Dolt commits --');
}
await c.end();
TS

    # helper: bottom pane — title card (7 s), then dolt.log watch
    T0_MS=$(( $(date +%s) * 1000 ))
    cat > /tmp/demo-watch.sh <<WATCH
#!/usr/bin/env bash
clear
echo
echo "   communico — a Matrix homeserver where the database is version-controlled"
echo "   ------------------------------------------------------------------------"
echo "   Server storage: Doltgres. Every Matrix event lands as a Dolt COMMIT;"
echo "   the event id a client sees is a content hash of the event itself;"
echo "   the commit hash is the server's per-store receipt for it."
echo
echo "   top panes: alice and bob — two unmodified matrix-commander clients"
echo "              having a conversation through this homeserver"
echo "   this pane: the room's database — dolt.log, refreshed every 2 s"
echo "   (a third participant will join — watch who)"
sleep 7
# the reveal timestamp travels as env into the watch query (§13.2.3 —
# printed every render cycle once past t≈58)
while true; do
  docker exec -i -w /workspace -e DEMO_ROOM_ID='$ROOM_ID' -e DEMO_WATCH_T0='$T0_MS' $CONTAINER \
    deno run --allow-net --allow-env - < /tmp/demo-watch.ts 2>/dev/null
  sleep 2
done
WATCH

    # helpers: each top pane is a PARTICIPANT — listener in the
    # background of the pane + that user's paced sends in the foreground.
    # Two client sessions per user (listen-store, send-store) so the two
    # nio processes don't fight over one sqlite file.
    # Conversation alternates: bob (t~12, t~24) / alice (t~18, t~30).
    make_participant() { # $1=name $2=listen-store $3=send-store $4=first-sleep $5=msg1 $6=gap $7=msg2 $8=tail
      cat > "/tmp/demo-$1.sh" <<PART
#!/usr/bin/env bash
clear
# fresh listen log for THIS run (stale lines from earlier runs would
# otherwise linger in the tee'd file and poison the dry-run checks)
: > /tmp/demo-$1-listen.log
# background listener uses its own store
docker run --rm -i --network container:$CONTAINER -v $2:/data:z -w /data $MC_IMAGE \
  --listen forever --plain --log-level WARNING WARNING \
  --store /data/store --credentials /data/credentials.json 2>&1 | tee /tmp/demo-$1-listen.log &
sleep $4
# foreground sender uses a separate store (no sqlite fight)
docker run --rm --network container:$CONTAINER -v $3:/data:z -w /data $MC_IMAGE \
  -m "$5" --room '$ROOM_ID' --plain --store /data/store --credentials /data/credentials.json
sleep $6
docker run --rm --network container:$CONTAINER -v $3:/data:z -w /data $MC_IMAGE \
  -m "$7" --room '$ROOM_ID' --plain --store /data/store --credentials /data/credentials.json
$8
sleep 999
PART
      chmod +x "/tmp/demo-$1.sh"
    }
    make_participant bob /tmp/mc-bob /tmp/mc-bob-send 12 \
      'hey alice — every message we send becomes a commit down there' 7 \
      'room state at any moment is one AS OF query away' ''
    make_participant alice /tmp/mc-alice /tmp/mc-alice-send 18 \
      'and the event id is a content hash of the event — 43 chars, any store' 7 \
      'and syncing this room to another server is literally a dolt pull' \
      'sleep 26; docker run --rm --network container:'$CONTAINER' -v /tmp/mc-alice-send:/data:z -w /data '$MC_IMAGE' \
        -m "six voices below, one room — and one of us never had a server at all" --room '$ROOM_ID' --plain \
        --store /data/store --credentials /data/credentials.json'
    chmod +x /tmp/demo-watch.sh

    # pane 0 (top-left): alice — listening + sending
    tmux new-session -d -s "$SESSION" -x 140 -y 40 "/tmp/demo-alice.sh"
    # pane 1 (top-right): bob — listening + sending
    tmux split-window -h -t "$SESSION:0.0" "/tmp/demo-bob.sh"
    # pane 2 (bottom, ~45% height): title card, then dolt.log watch
    tmux split-window -v -f -l '45%' -t "$SESSION:0.0" "/tmp/demo-watch.sh"
    # labels
    tmux set-option -t "$SESSION" status off
    tmux set-option -t "$SESSION" pane-border-status top
    tmux select-pane -t "$SESSION:0.0" -T "alice — unmodified matrix-commander"
    tmux select-pane -t "$SESSION:0.1" -T "bob — same client, other side"
    tmux select-pane -t "$SESSION:0.2" -T "the room = a Doltgres database (dolt log)"
    echo ">> tmux session '$SESSION' running (host, 140x40). Attach with:"
    echo "   tmux attach -t $SESSION"
    ;;

  *)
    echo "usage: $0 [--check|--scripted]" >&2
    exit 2
    ;;
esac
