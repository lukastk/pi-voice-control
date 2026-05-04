#!/usr/bin/env bash
#
# Voice Agent Bridge — local dev supervisor.
#
# Boots three processes:
#   1. livekit-server --dev   (WebRTC + token auth)
#   2. voice-bridge worker    (LiveKit agent, explicit dispatch by agentName)
#   3. Bun HTTP server        (REST + UI)
#
# Pi sessions are NOT owned by this script. Start them separately in
# `tmux -L mysystem` (or whichever tmux socket you've configured); the
# rpc-socket extension exposes a Unix socket per Pi session, and you paste
# that path into the Sessions tab.
#
set -euo pipefail
cd "$(dirname "$0")/.."

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# --- pre-flight ----------------------------------------------------------

for cmd in bun livekit-server tmux; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}error:${NC} $cmd not found in PATH"
    exit 1
  fi
done

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo -e "${YELLOW}warning:${NC} OPENAI_API_KEY not set — STT will fail"
fi
if [ -z "${ELEVENLABS_API_KEY:-}" ] && [ -z "${ELEVEN_API_KEY:-}" ]; then
  echo -e "${YELLOW}warning:${NC} ELEVENLABS_API_KEY/ELEVEN_API_KEY not set — TTS will fail"
fi

# LiveKit ElevenLabs plugin reads ELEVEN_API_KEY; mirror from ELEVENLABS_API_KEY.
if [ -n "${ELEVENLABS_API_KEY:-}" ] && [ -z "${ELEVEN_API_KEY:-}" ]; then
  export ELEVEN_API_KEY="$ELEVENLABS_API_KEY"
fi

export LIVEKIT_URL="${LIVEKIT_URL:-ws://localhost:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"

# --- install + build -----------------------------------------------------

if [ ! -d node_modules ] || [ -n "${REINSTALL:-}" ]; then
  echo -e "${YELLOW}installing dependencies...${NC}"
  bun install
fi

# Build the client every time by default — UI changes need a fresh
# bundle and forgetting to rebuild is a recurring source of "why isn't
# my change showing up". Set SKIP_CLIENT_BUILD=1 for fast restarts when
# you know the bundle is current. Always builds if dist is missing,
# regardless of the env flag (serving a missing bundle isn't useful).
if [ ! -f client/dist/index.html ] || [ -z "${SKIP_CLIENT_BUILD:-}" ]; then
  echo -e "${YELLOW}building client...${NC}"
  (cd client && bun run build)
fi

# --- process supervision -------------------------------------------------

PIDS=()
SHUTTING_DOWN=0

cleanup() {
  # idempotent: SIGINT may fire multiple times before processes exit
  if [ "$SHUTTING_DOWN" = "1" ]; then return; fi
  SHUTTING_DOWN=1
  # Write to stderr (unbuffered) so the message survives even if stdout
  # gets dropped on a fast-exiting bash.
  printf '\n%bshutting down...%b\n' "$YELLOW" "$NC" >&2
  for pid in "${PIDS[@]:-}"; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      # kill children first (LiveKit worker spawns job_proc subprocs)
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
  done
  # give children a moment to exit gracefully, then SIGKILL the holdouts
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      pkill -9 -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  # extra guards for orphaned subprocesses scoped to this repo
  pkill -f "$PWD/worker/src/agent.ts" 2>/dev/null || true
  pkill -f "$PWD/wterm/server.mjs" 2>/dev/null || true
  # rtc-node sometimes leaves a job_proc_lazy_main.js worker behind after a
  # native cleanup race ("libc++abi: mutex lock failed"). Force-kill any
  # node processes that look like ours to keep ports free for the next run.
  sleep 0.3
  pkill -9 -f "job_proc_lazy_main.js.*worker/src/agent.ts" 2>/dev/null || true
  echo -e "${GREEN}done.${NC}"
}
trap cleanup EXIT INT TERM

echo -e "${GREEN}1.${NC} starting livekit-server (dev)"
# Bind localhost only — Tailscale Serve, if active, listens on the Tailnet
# interface at the same port and forwards to localhost. Binding 0.0.0.0
# would collide with Tailscale Serve and abort livekit on startup.
livekit-server --dev --bind 127.0.0.1 >/tmp/voice-agent-bridge-livekit.log 2>&1 &
PIDS+=($!)

# Brief grace for livekit-server to bind sockets before the worker tries to register.
sleep 1.5

echo -e "${GREEN}2.${NC} starting voice-bridge worker"
# Worker diagnostic log. The framework forks each job into a subprocess
# whose stdout we can't capture from out here, so the worker also writes
# its key events directly to this file via fs.appendFileSync (see diagLog
# in worker/src/agent.ts). We tee the parent's stdout in append mode so
# our two writers don't race.
WORKER_LOG="/tmp/voice-bridge-worker.log"
: >"$WORKER_LOG"
(cd worker && bun run dev) > >(tee -a "$WORKER_LOG") 2>&1 &
PIDS+=($!)

PORT="${PORT:-7890}"
BIND="${BIND:-0.0.0.0}"
echo -e "${GREEN}3.${NC} starting HTTP server on http://${BIND}:${PORT}"
echo ""
echo -e "  Web client:  http://localhost:${PORT}"
echo -e "  Worker log:  ${WORKER_LOG}"
echo -e "  LiveKit:     ${LIVEKIT_URL}"
echo -e "  Pi sockets:  /tmp/pi-rpc-sockets/"
echo ""
echo -e "Press ${YELLOW}Ctrl+C${NC} to stop. Pi tmux sessions are not touched."
echo ""

# Run the HTTP server in the background and wait, so the trap can fire on
# Ctrl+C. Using `exec` would replace the shell and kill the trap. Disable
# errexit around wait — when interrupted by a signal it returns non-zero,
# and with `set -e` that aborts the script before the INT/TERM trap fires.
bun server/src/main.ts &
PIDS+=($!)

set +e
while true; do
  wait -n 2>/dev/null
  status=$?
  # status 130 = SIGINT, 143 = SIGTERM, 0..127 = normal exit, 128+N = signaled
  if [ "$SHUTTING_DOWN" = "1" ]; then break; fi
  # if any single child exited normally (status < 128), tear the rest down too
  if [ "$status" -lt 128 ] && [ "$status" -ne 127 ]; then
    cleanup
    break
  fi
  # signaled child — let trap handle it
done
