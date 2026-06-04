#!/usr/bin/env bash
# Throwaway probe for the Phase-1 join: does sesh list --agent pi --json
# enumerate live pi sessions with uuid == socket basename?
set -uo pipefail
cd "$(dirname "$0")"
DIR=/tmp/pi-rpc-sockets

echo "===================== SOCKETS ON DISK ====================="
ls -1 "$DIR"/*.sock 2>/dev/null | while read -r s; do
  bn=$(basename "$s" .sock)
  state=$(node probe-socket.mjs "$s" 2>&1)
  echo "socket=$bn"
  echo "  getState -> $state" | cut -c1-200
done

echo
echo "===================== sesh list --agent pi --json ====================="
PI_JSON=$(sesh list --agent pi --json 2>&1)
echo "$PI_JSON" | jq -c '.[] | {uuid, name, machine, turnStatus, cwd, tags, contextPct, tmux}' 2>/dev/null || echo "$PI_JSON" | head -c 400

echo
echo "===================== JOIN: socket basename <-> sesh uuid ====================="
for s in "$DIR"/*.sock; do
  [ -e "$s" ] || continue
  bn=$(basename "$s" .sock)
  match=$(echo "$PI_JSON" | jq -r --arg u "$bn" '.[] | select(.uuid==$u) | .name' 2>/dev/null)
  if [ -n "$match" ]; then
    echo "socket $bn  ==> MATCHED sesh record name=\"$match\""
  else
    echo "socket $bn  ==> no sesh record (bare/unregistered pi -> fallback)"
  fi
done

echo
echo "===================== latency of sesh list (x3) ====================="
for i in 1 2 3; do
  start=$(node -e 'console.log(Date.now())')
  sesh list --agent pi --json >/dev/null 2>&1
  end=$(node -e 'console.log(Date.now())')
  echo "  run $i: $((end-start)) ms"
done

echo
echo "===================== daemon-unreachable behaviour ====================="
echo "-- bogus --socket path:"
timeout_bin=$(command -v timeout || command -v gtimeout || true)
out=$(sesh list --agent pi --json --socket /tmp/does-not-exist-$$.sock 2>&1); rc=$?
echo "  exit=$rc out=$(echo "$out" | head -c 200)"
