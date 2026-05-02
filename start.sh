#!/usr/bin/env bash
# Convenience entrypoint at the repo root. Forwards to bin/start.sh.
exec "$(dirname "$0")/bin/start.sh" "$@"
