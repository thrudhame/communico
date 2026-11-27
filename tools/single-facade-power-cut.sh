#!/usr/bin/env bash
# Guest-only gate, following xfstests generic/482. REPLAY_LOG must point to
# xfstests src/log-writes/replay-log; record the upstream revision with evidence.
set -euo pipefail
umask 077
export LC_ALL=C
die() { printf '%s\n' "$*" >&2; exit 1; }

[[ $(hostname -s) = communico-interop && $(id -un) = tester ]] || die 'requires communico-interop as tester'
[[ $# = 2 && ( $1 = preflight || $1 = replay ) ]] || die "usage: $0 preflight|replay <block-workspace>"
src=$(pwd -P)
run=$(dirname "$src")
root=$(realpath -m -- "$2")
[[ $run = /srv/data/* && $src = "$run/src" && $root = "$run/block" ]] || die 'use private /srv/data workspace with sibling src/ and block/'
[[ -d ${TMPDIR:-} && $(realpath -e "$TMPDIR") = "$run/"* && $(findmnt -n -o TARGET -T "$TMPDIR") = /srv/data ]] || die 'use private disk-backed TMPDIR'
[[ $(findmnt -n -o TARGET -T "$run") = /srv/data ]] || die 'workspace must be on /srv/data'
[[ -x ${REPLAY_LOG:-} ]] || die 'set REPLAY_LOG to the guest xfstests replay-log binary'
for tool in mkfs.ext4 e2fsck setquota dmsetup losetup blockdev modprobe; do
  sudo -n sh -c 'command -v "$1"' _ "$tool" >/dev/null || die "missing $tool"
done
read -r available unit < <(stat -f -c '%a %S' "$run")
((available * unit >= 1024 * 1024 * 1024)) || die 'need 1 GiB workspace space'
sudo -n modprobe dm-log-writes
sudo -n modprobe dm-snapshot

if [[ $1 = preflight ]]; then
  [[ ! -e $root && ! -L $root ]] || die 'block workspace already exists'
  timeout 60s deno eval 'import { Turso } from "./api/engine/store/ffi.ts"; import { checkBuildInfo } from "./api/engine/store/build.ts"; checkBuildInfo(await new Turso("./.native/libturso_ffi.so").buildInfo()); console.log("ABI OK");'
  printf 'preflight OK: guest=%s filesystem=%s replay-log=%s\n' "$(uname -r)" "$(findmnt -n -o FSTYPE -T "$run")" "$REPLAY_LOG"
  exit
fi

mkdir -- "$root" # exclusive, never reuse a previous run
name=sf-cut-$$
logger=$name-log
snap=$name-snap
mnt=$root/mount
data_root=$mnt/facade
ledger=$root/acks.jsonl
mkdir -- "$mnt"
loops=()
log_live=false
snap_live=false
mounted=false
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  if "$mounted"; then sudo -n umount -- "$mnt" || rc=1; fi
  if "$snap_live"; then sudo -n dmsetup remove "$snap" || rc=1; fi
  if "$log_live"; then sudo -n dmsetup remove "$logger" || rc=1; fi
  for dev in "${loops[@]}"; do sudo -n losetup -d "$dev" || rc=1; done
  printf 'teardown rc=%s\n' "$rc"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

attach() {
  local slot=$1 dev
  dev=$(sudo -n losetup --find --show -- "$2")
  loops+=("$dev")
  printf -v "$slot" '%s' "$dev"
}
mount_volume() {
  # The on-disk quota feature alone accounts usage; the mount option
  # explicitly requests user quota enforcement, also during replay.
  sudo -n mount -t ext4 -o data=ordered,nodiscard,usrquota "$1" "$mnt" || return
  mounted=true
}
unmount_volume() {
  sudo -n umount -- "$mnt" || return
  mounted=false
}
mark() { sudo -n dmsetup message "$logger" 0 mark "$1"; }
fixture() {
  timeout 60s deno run --allow-env --allow-read --allow-write --allow-run=sudo --allow-ffi \
    --allow-sys=uid,umask,statfs tools/single-facade-power-cut.ts "$1" "$data_root" "$ledger" "${@:2}"
}
errno_probe() {
  python3 - "$data_root" "$1" <<'PY'
import errno
import os
import sys
import tempfile

with tempfile.TemporaryFile(dir=sys.argv[1]) as probe:
    try:
        os.posix_fallocate(probe.fileno(), 0, 4 * 1024 * 1024)
    except OSError as exc:
        if exc.errno != getattr(errno, sys.argv[2]):
            raise
        print(f"kernel refused 4 MiB: {sys.argv[2]}")
    else:
        raise RuntimeError(f"expected {sys.argv[2]}")
PY
}

truncate -s 128M "$root/data.img" "$root/cow.img"
truncate -s 512M "$root/log.img"
attach data "$root/data.img"
attach log "$root/log.img"
sectors=$(sudo -n blockdev --getsz "$data")
sudo -n mkfs.ext4 -q -F -m 0 -O quota -E quotatype=usrquota,lazy_itable_init=0,lazy_journal_init=0 "$data"
mount_volume "$data"
sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$data_root"
fixture init
unmount_volume
cp --sparse=always -- "$root/data.img" "$root/replay.img"

sudo -n dmsetup create "$logger" --table "0 $sectors log-writes $data $log"
log_live=true
mount_volume "/dev/mapper/$logger"
mark start
fixture record "$logger" 1

# Keep ordinary app capacity uncapped in both legs. Prove that the kernel is
# enforcing each limit, not merely that the facade refuses a large request.
kib=$(du -sk "$data_root" | cut -f1)
limit=$((kib + 1024))
sudo -n setquota -u "$(id -u)" "$limit" "$limit" 0 0 "$mnt"
errno_probe EDQUOT
fixture pressure quota
mark pressure-quota
sudo -n setquota -u "$(id -u)" 0 0 0 0 "$mnt"

read -r blocks blocksize < <(stat -f -c '%a %S' "$mnt")
fallocate -l "$((blocks * blocksize - 2 * 1024 * 1024))" "$data_root/filler"
errno_probe ENOSPC
fixture pressure physical
mark pressure-physical
rm -- "$data_root/filler"
fixture record "$logger" 3
unmount_volume
mark end
sudo -n dmsetup remove "$logger"
log_live=false
sudo -n udevadm settle

attach replay "$root/replay.img"
attach cow "$root/cow.img"
find_entry() { sudo -n "$REPLAY_LOG" --log "$log" --find "$@"; }
entry_at() {
  local point
  point=$(find_entry --end-mark "$1")
  [[ $point =~ ^[0-9]+@[0-9]+$ ]] || die "bad mark: $1"
  printf '%s\n' "${point%@*}"
}
start=$(entry_at start)
last=$(entry_at end)
python3 - "$ledger" > "$root/ack-marks" <<'PY'
import json
import sys

with open(sys.argv[1]) as ledger:
    for line in ledger:
        ack = json.loads(line)
        print(f"ack-{ack['step']}-{ack['id']}")
PY
test "$(wc -l < "$root/ack-marks")" -eq 21
{
  printf '%s start\n' "$start"
  while IFS= read -r mark_name; do printf '%s %s\n' "$(entry_at "$mark_name")" "$mark_name"; done < "$root/ack-marks"
  for point in pressure-quota pressure-physical end; do printf '%s %s\n' "$(entry_at "$point")" "$point"; done
  from=$((start + 1))
  # This trace is short: check every flush/FUA rather than sample the tail.
  while ((from < last)); do
    if ! point=$(find_entry --start-entry "$from" --next-flush --next-fua 2> "$root/find.stderr"); then
      [[ $(cat "$root/find.stderr") = "Couldn't find entry" ]] || die 'cannot enumerate flush/FUA entries'
      break
    fi
    [[ $point =~ ^[0-9]+@[0-9]+$ ]] || die 'malformed flush/FUA entry'
    point=${point%@*}
    ((point >= from)) || die 'nonmonotone flush/FUA index'
    if ((point >= last)); then break; fi
    printf '%s flush-fua\n' "$point"
    from=$((point + 1))
  done
} > "$root/points.unsorted"
sort -n -k1,1 "$root/points.unsorted" > "$root/points.tsv"
awk 'NR>1 && $1<=prior {exit 1} {prior=$1}' "$root/points.tsv" || die 'duplicate or unordered cut'
grep -q ' flush-fua$' "$root/points.tsv" || die 'no flush/FUA cuts'

check_cut() {
  local point=$1 expected=$2 rc=0
  sudo -n dmsetup create "$snap" --table "0 $sectors snapshot $replay $cow N 8"
  snap_live=true
  local dev=/dev/mapper/$snap
  if mount_volume "$dev"; then
    unmount_volume || die 'cannot unmount recovery snapshot'
    sudo -n e2fsck -fn "$dev" || rc=1
    if ((rc == 0)) && mount_volume "$dev"; then
      fixture verify "$expected" || rc=1
      unmount_volume || die 'cannot unmount verification snapshot'
    else
      rc=1
    fi
  else
    rc=1
  fi
  sudo -n dmsetup remove "$snap" || die 'cannot remove replay snapshot'
  snap_live=false
  printf '%s acks=%s rc=%s\n' "$point" "$expected" "$rc"
  return "$rc"
}

# Verify the seed itself, then demand the first ACK from the same pre-barrier
# state. The failure must be the missing control write, not a mount/ABI error.
check_cut seed 0 > "$root/seed.log" 2>&1
if check_cut dropped-barrier 1 > "$root/control.log" 2>&1; then die 'positive control passed'; fi
grep -Fq 'AssertionError: Values are not equal: ACK_LOST control' "$root/control.log" || die 'positive control did not detect missing ACK'

prior=-1 count=0 cuts=0 failures=0
: > "$root/results.tsv"
while read -r point label; do
  sudo -n "$REPLAY_LOG" --log "$log" --replay "$replay" --start-entry "$((prior + 1))" --limit "$((point - prior))"
  sudo -n blockdev --flushbufs "$replay"
  if [[ $label = ack-* ]]; then
    count=$((count + 1))
    [[ $label = "$(sed -n "${count}p" "$root/ack-marks")" ]] || die 'ACK order differs from ledger'
  fi
  if check_cut "$point-$label" "$count" > "$root/cut-$point.log" 2>&1; then
    printf '%s %s %s ok\n' "$point" "$label" "$count" >> "$root/results.tsv"
  else
    printf '%s %s %s failed\n' "$point" "$label" "$count" >> "$root/results.tsv"
    failures=$((failures + 1))
  fi
  prior=$point
  cuts=$((cuts + 1))
done < "$root/points.tsv"
printf 'replay cuts=%s acks=%s failures=%s positive-control=ACK_LOST\n' "$cuts" "$count" "$failures"
((count == 21 && failures == 0))
