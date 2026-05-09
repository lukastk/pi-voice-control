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
if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found in PATH" >&2
  exit 1
fi

tailscale status --json | bun -e '
let s = "";
for await (const c of process.stdin) s += c;
const j = JSON.parse(s);
if (j.BackendState !== "Running") {
  console.error(`error: tailscale not up (BackendState=${j.BackendState})`);
  process.exit(1);
}
const dns = j.Self?.DNSName?.replace(/\.$/, "");
if (!dns) {
  console.error("error: tailscale Self.DNSName not set");
  process.exit(1);
}
console.log(`https://${dns}/`);
'
