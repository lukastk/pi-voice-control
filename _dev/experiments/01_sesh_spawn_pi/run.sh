#!/usr/bin/env bash
# Throwaway probe for Phase-2 spawn-via-sesh (variant B):
#   sesh new --no-launch --json -> {uuid, launch}
#   run `launch` in a detached tmux window
#   wait for the SPECIFIC <uuid>.sock to appear
#   confirm dial-able + registered in sesh list with tag + tmux locator
# Cleans up the throwaway tmux session and sesh record at the end.
set -uo pipefail
cd "$(dirname "$0")"

SOCK_NAME=mysystem
TMUX_SESSION=exp01-spawn          # isolated throwaway, not the real voice-bridge-pi
CWD=/Users/lukas/mysetup/pi-voice-control
SOCKDIR=/tmp/pi-rpc-sockets

echo "===================== 1. sesh new --no-launch --json ====================="
NEW_JSON=$(sesh new --agent pi --cwd "$CWD" --tag voice --no-launch --json 2>&1)
echo "$NEW_JSON"
UUID=$(echo "$NEW_JSON" | jq -r '.uuid')
LAUNCH=$(echo "$NEW_JSON" | jq -r '.launch')
echo
echo "uuid   = $UUID"
echo "launch = $LAUNCH"

echo
echo "===================== 2. run launch in detached tmux window ====================="
tmux -L "$SOCK_NAME" new-session -d -s "$TMUX_SESSION" -c "$CWD" 2>/dev/null || true
# run the launch string via the shell, mirroring how tmux would invoke a window command
tmux -L "$SOCK_NAME" new-window -t "$TMUX_SESSION" -c "$CWD" -n exp01 "$LAUNCH"
echo "launched window exp01 in $SOCK_NAME:$TMUX_SESSION"

echo
echo "===================== 3. wait for <uuid>.sock (deterministic) ====================="
TARGET="$SOCKDIR/$UUID.sock"
found=no
for i in $(seq 1 40); do
  if [ -S "$TARGET" ]; then found=yes; echo "appeared after ~$((i*500))ms: $TARGET"; break; fi
  sleep 0.5
done
if [ "$found" != yes ]; then
  echo "DID NOT APPEAR within 20s. Pane content:"
  tmux -L "$SOCK_NAME" capture-pane -p -t "$TMUX_SESSION:exp01" 2>&1 | tail -20
fi

echo
echo "===================== 4. probe the socket ====================="
[ -S "$TARGET" ] && node ../00_sesh_query_and_join/probe-socket.mjs "$TARGET" | cut -c1-220

echo
echo "===================== 5. sesh list shows it (uuid/tag/tmux) ====================="
sesh list --agent pi --json 2>&1 | jq -c --arg u "$UUID" '.[] | select(.uuid==$u) | {uuid,name,turnStatus,cwd,tags,tmux}'

echo
echo "===================== 6. JOIN check: socket basename == uuid? ====================="
if [ -S "$TARGET" ]; then echo "socket basename = $(basename "$TARGET" .sock)"; echo "sesh uuid       = $UUID"; fi

echo
echo "===================== CLEANUP ====================="
tmux -L "$SOCK_NAME" kill-session -t "$TMUX_SESSION" 2>/dev/null && echo "killed tmux $TMUX_SESSION" || true
sesh delete "$UUID" 2>&1 | head -1 || true
sleep 1
[ -S "$TARGET" ] && echo "NOTE: socket still present (pi may linger): $TARGET" || echo "socket gone"
