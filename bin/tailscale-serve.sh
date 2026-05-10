#!/usr/bin/env bash
#
# Expose the voice-agent-bridge stack on Tailscale with auto-HTTPS so mobile
# browsers will let getUserMedia (microphone) work. Tailscale's built-in
# serve mode generates a real cert for your Tailnet hostname.
#
# After running this once, open https://<your-tailnet-name>/ on your phone
# and Connect voice should work — no self-signed cert dance.
#
# To tear down: `tailscale serve reset` or this script's --off flag.
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale not found — install from https://tailscale.com/download"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found — install via brew/apt"
  exit 1
fi

if [ "${1:-}" = "--off" ] || [ "${1:-}" = "off" ]; then
  echo "tearing down tailscale serve…"
  tailscale serve reset || true
  exit 0
fi

# Main HTTP server (UI + REST + SSE) on standard 443.
tailscale serve --bg --https=443 http://localhost:7890
# wterm subprocess (terminal pty WebSocket).
tailscale serve --bg --https=7891 http://localhost:7891
# LiveKit dev server (signaling + WebRTC TURN setup).
tailscale serve --bg --https=7880 http://localhost:7880

echo ""
tailscale serve status
echo ""
dns=$(tailscale status --json | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
echo "Open https://${dns:-<your-tailnet>}/ on your phone."
echo ""
echo "Tear down with: $0 --off"
