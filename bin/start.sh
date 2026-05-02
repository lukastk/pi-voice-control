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

if [ ! -f client/dist/index.html ] || [ -n "${REBUILD_CLIENT:-}" ]; then
  echo -e "${YELLOW}building client...${NC}"
  (cd client && bun run build)
fi

# --- process supervision -------------------------------------------------

PIDS=()

cleanup() {
  echo ""
  echo -e "${YELLOW}shutting down...${NC}"
  for pid in "${PIDS[@]:-}"; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      # kill children first (LiveKit worker spawns job_proc subprocs)
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  # extra guard for orphaned worker job processes scoped to this repo
  pkill -f "$PWD/worker/src/agent.ts" 2>/dev/null || true
  echo -e "${GREEN}done.${NC}"
}
trap cleanup EXIT INT TERM

echo -e "${GREEN}1.${NC} starting livekit-server (dev)"
livekit-server --dev --bind 0.0.0.0 >/tmp/voice-agent-bridge-livekit.log 2>&1 &
PIDS+=($!)

# Brief grace for livekit-server to bind sockets before the worker tries to register.
sleep 1.5

echo -e "${GREEN}2.${NC} starting voice-bridge worker"
(cd worker && bun run dev) &
PIDS+=($!)

PORT="${PORT:-7890}"
BIND="${BIND:-0.0.0.0}"
echo -e "${GREEN}3.${NC} starting HTTP server on http://${BIND}:${PORT}"
echo ""
echo -e "  Web client:  http://localhost:${PORT}"
echo -e "  LiveKit:     ${LIVEKIT_URL}"
echo -e "  Pi sockets:  /tmp/pi-rpc-sockets/"
echo ""
echo -e "Press ${YELLOW}Ctrl+C${NC} to stop. Pi tmux sessions are not touched."
echo ""

exec bun server/src/main.ts
