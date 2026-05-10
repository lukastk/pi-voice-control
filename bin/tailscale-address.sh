#!/usr/bin/env bash
#
# Print the Tailnet HTTPS URL the voice-agent-bridge stack is served at
# (whatever Tailscale generates for this machine's tailnet hostname).
#
# Exits non-zero if Tailscale isn't installed, isn't logged in, or
# doesn't yet have a DNSName for this node — `tailscale status --json`
# returns 0 even when the daemon is logged out, so we have to inspect
# BackendState ourselves.
#
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: tailscale not found in PATH" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found in PATH" >&2
  exit 1
fi

status_json=$(tailscale status --json)
backend_state=$(printf '%s' "$status_json" | jq -r '.BackendState // empty')
if [ "$backend_state" != "Running" ]; then
  echo "error: tailscale not up (BackendState=$backend_state)" >&2
  exit 1
fi
dns=$(printf '%s' "$status_json" | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
if [ -z "$dns" ]; then
  echo "error: tailscale Self.DNSName not set" >&2
  exit 1
fi
echo "https://${dns}/"
