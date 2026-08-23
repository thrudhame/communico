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
      const c = new pgpkg.Client({host:'127.0.0.1',port:5432,user:'root',password:'secret',database:'postgres'});
      await c.connect();
      const r = await c.query(\\\"SELECT room_id FROM event_index WHERE room_id IN (SELECT room_id FROM room_directory WHERE room_version='test.communico.dolt.v1') GROUP BY room_id ORDER BY MAX(seq) DESC LIMIT 1;\\\");
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
  docker run --rm --network container:$CONTAINER -v /tmp/mc-bob:/data:z -w /data \\
    $MC_IMAGE -m "hello alice via doltgres" --room '$ROOM_ID' --plain \\
    --store /data/store --credentials /data/credentials.json

TERMINAL 3 — watch the conversation become commits (every 2 s):
  watch -n2 "docker exec $CONTAINER bash -c 'cd /workspace && deno eval \"
    import pgpkg from \\\"pg\\\";
    const root = new pgpkg.Client({host:\\\"127.0.0.1\\\",port:5432,user:\\\"root\\\",password:\\\"secret\\\",database:\\\"postgres\\\"});
    await root.connect();
    const db = (await root.query(\\\"SELECT db_name FROM room_directory WHERE room_id=\\\\\\\"$ROOM_ID\\\\\\\"\\\")).rows[0].db_name;
    await root.end();
    const c = new pgpkg.Client({host:\\\"127.0.0.1\\\",port:5432,user:\\\"root\\\",password:\\\"secret\\\",database:db});
    await c.connect();
    const xb = (await c.query(\\\"SELECT name FROM dolt.branches WHERE name LIKE \\\\\\\"x%\\\\\\\" LIMIT 1;\\\")).rows[0].name;
    await c.query(\\\"SELECT DOLT_CHECKOUT(\\\\\\\"\\\"+xb+\\\"\\\\\\\");\\\");
    console.log((await c.query(\\\"SELECT message FROM dolt.log LIMIT 5;\\\")).rows.map(r=>r.message).join(\\\"\\\\n\\\"));
    await c.end();
  \"'"

Each send prints an event id of the form \$<32 chars> — that IS the Dolt
commit hash of the message's commit (room version test.communico.dolt.v1).
Then open demo/inspection-tour.md.
EOF
    ;;

  --check)
    BODY="check-$(date +%s)-$RANDOM"
    echo ">> Act 1: bob sends '$BODY'"
    mc /tmp/mc-bob -m "$BODY" --room "$ROOM_ID" --plain
    echo ">> Act 2: alice listens once"
    # --output json: the event id only appears in debug/json output, and
    # the check greps for it (\$<32 chars> == the Dolt commit hash)
    OUT="$(mc /tmp/mc-alice --listen once --plain --output json 2>&1 || true)"
    PASS=1
    if grep -q "$BODY" <<<"$OUT"; then
      echo "   body found in alice's output ✓"
    else
      echo "   BODY NOT FOUND in alice's output" >&2; PASS=0
    fi
    if grep -qE '\$[a-z0-9]{32}' <<<"$OUT"; then
      echo "   event id '\$<32 chars>' (= Dolt commit hash) found ✓"
    else
      echo "   no \$<32 chars> event id in alice's output" >&2; PASS=0
    fi
    if [[ $PASS == 1 ]]; then echo "CHECK: PASS"; else echo "CHECK: FAIL" >&2; exit 1; fi
    ;;

  --scripted)
    # Q5/A: host-side tmux (the container has no docker CLI/socket, so
    # container-side tmux cannot run the matrix-commander panes). The
    # recorder attaches with: tmux attach -t communico-demo
    command -v tmux >/dev/null || { echo "tmux not found on host" >&2; exit 1; }
    SESSION=communico-demo
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    # pane 0: alice listening (real client, host-side docker run)
    tmux new-session -d -s "$SESSION" -x 220 -y 50 \
      "docker run --rm -it --network container:$CONTAINER -v /tmp/mc-alice:/data:z -w /data $MC_IMAGE --listen forever --plain --store /data/store --credentials /data/credentials.json 2>&1 | tee /tmp/demo-listen.log"
    # pane 1: watch the room DB's dolt.log (every 2 s)
    tmux split-window -v -t "$SESSION" \
      "while true; do docker exec $CONTAINER bash -c 'cd /workspace && deno eval \"
        import pgpkg from \\\"pg\\\";
        const root = new pgpkg.Client({host:\\\"127.0.0.1\\\",port:5432,user:\\\"root\\\",password:\\\"secret\\\",database:\\\"postgres\\\"});
        await root.connect();
        const db = (await root.query(\\\"SELECT db_name FROM room_directory WHERE room_id=\\\\\\\"$ROOM_ID\\\\\\\"\\\")).rows[0].db_name;
        await root.end();
        const c = new pgpkg.Client({host:\\\"127.0.0.1\\\",port:5432,user:\\\"root\\\",password:\\\"secret\\\",database:db});
        await c.connect();
        const xb = (await c.query(\\\"SELECT name FROM dolt.branches WHERE name LIKE \\\\\\\"x%\\\\\\\" LIMIT 1;\\\")).rows[0].name;
        await c.query(\\\"SELECT DOLT_CHECKOUT(\\\\\\\"\\\"+xb+\\\"\\\\\\\");\\\");
        console.clear(); console.log((await c.query(\\\"SELECT commit_hash, message FROM dolt.log LIMIT 10;\\\")).rows.map(r=>r.commit_hash.slice(0,8)+\\\"  \\\"+r.message).join(\\\"\\\\n\\\"));
        await c.end();\"' 2>/dev/null; sleep 2; done"
    # pane 2: sender lane — paced sends, 4 distinct bodies, ~3 s apart
    tmux split-window -h -t "$SESSION"
    tmux send-keys -t "$SESSION:0.2" \
      "sleep 6; for m in 'one: messages become commits' 'two: extremities are branches' 'three: state at any commit via AS OF' 'four: federation is a dolt pull'; do docker run --rm --network container:$CONTAINER -v /tmp/mc-bob:/data:z -w /data $MC_IMAGE -m \"\$m\" --room '$ROOM_ID' --plain --store /data/store --credentials /data/credentials.json; sleep 3; done" Enter
    echo ">> tmux session '$SESSION' running (host). Attach with:"
    echo "   tmux attach -t $SESSION"
    ;;

  *)
    echo "usage: $0 [--check|--scripted]" >&2
    exit 2
    ;;
esac
