# 00 — sesh query & join: FINDINGS

**Status:** done (2026-06-04). Run env: macbook (live sesh-daemon, `tmux -L mysystem`, pi sockets in `/tmp/pi-rpc-sockets`).

## What we learned (affects production design)

- **`sesh list --agent pi --json` works and is cheap.** ~55–60 ms per call on a daemon with 83 sessions → fine to call on the existing 2 s poll. Artifact: [`run.sh`](run.sh).
- **The join key is confirmed at the protocol level.** A live pi session's rpc `getState` reply contains `state.sessionId`, and that equals the socket file's basename (`<sessionId>.sock`). sesh stores the same value as `record.uuid`. So `PiSession.sessionId === sesh.uuid` is the join. (The *positive* end-to-end match against a real sesh record is demonstrated in experiment `01`.)
- **JSON record shape** (fields we'll consume): `uuid, name, machine, cwd, turnStatus ("idle"|"busy"|"unknown"), contextPct, tags[], summary, tmux{socket,session,window,pane}`. `tmux.socket` is the *resolved path* (e.g. `/private/tmp/tmux-501/mysystem`), not the `-L` name — irrelevant to us since we join on uuid.
- **Bare pi sessions are invisible to sesh.** The two live pi sockets on disk were started outside sesh and did **not** appear in `sesh list --agent pi` (empty array). → Enrichment must be best-effort with a clean fallback to today's display for unmatched sockets. This is the common case until sessions are created through sesh.
- **Daemon-unreachable is catchable.** `sesh list --socket /bad.sock` → exit 1 with a clear gRPC "Unavailable" message on stderr. So a `try/catch` around the exec (non-zero exit OR ENOENT) degrades to an empty enrichment map.

## Production implications

- Poller: after the socket snapshot, run `sesh list --agent pi --json` (abs-path bin, ~2 s exec timeout), build a `uuid → record` map, attach `sesh` to each `PiSession` by `sessionId`. Wrap in try/catch → empty map on any failure (logged once).
- No `--machine` filter needed: remote records won't have a matching local socket, so the uuid join naturally drops them.

## Artifacts
- [`run.sh`](run.sh) — the probe (sockets ↔ sesh join, latency, degradation).
- [`probe-socket.mjs`](probe-socket.mjs) — minimal pi-rpc `getState` dialer (reused by `01`).
