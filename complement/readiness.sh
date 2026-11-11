#!/usr/bin/env bash
# One elapsed budget, including probes and sleeps. Commands are argv, not code.
wait_ready_within() {
  local budget=$1
  shift
  local deadline=$((SECONDS + budget)) remaining probe
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    probe=$remaining
    (( probe <= 5 )) || probe=5
    if timeout "${probe}s" "$@" >/dev/null 2>&1; then
      (( SECONDS < deadline )) && return 0
    fi
    (( SECONDS < deadline )) || break
    sleep 1
  done
  return 1
}
