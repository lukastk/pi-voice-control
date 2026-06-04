# 01 — spawn pi via sesh: FINDINGS

**Status:** done (2026-06-04). Run env: macbook. Artifact: [`run.sh`](run.sh) (self-cleaning).

## What we learned (affects production design)

- **`sesh new --agent pi --cwd <dir> --tag <t> --no-launch --json` returns `{uuid, launch}`** deterministically. The `launch` is a shell string:
  ```
  mkdir -p '<cwd>' && cd '<cwd>' && SESH_SESSION_ID='<uuid>' pi '--session-id' '<uuid>'
  ```
  (It pre-`mkdir`s the cwd, sets `SESH_SESSION_ID`, and pins `--session-id`. Model flags would appear here if configured.)
- **Running `launch` in a detached tmux window produces `<uuid>.sock`.** Passing the launch string as the single command arg to `tmux -L mysystem new-window …` works (tmux runs it via the shell). The socket `/tmp/pi-rpc-sockets/<uuid>.sock` appeared in **~3.5 s**, probed live (`getState.sessionId == uuid`, correct cwd).
- **Deterministic wait works.** Because we know the uuid up front, the spawn can poll for that *specific* `<uuid>.sock` instead of today's "diff the whole sockets dir" — simpler and race-free.
- **The session registers correctly.** `sesh list --agent pi --json` immediately showed it: `tags:["voice"]` stuck, `tmux:{socket,session,window,pane:%19}` populated, `turnStatus:"idle"`, `cwd` correct. `name:""` because we omitted `--name` (AutoRename fills it after the first turn).
- **Join confirmed positively:** `basename(<uuid>.sock) === sesh.record.uuid`. ✅ (closes experiment `00`'s positive case.)
- **Variant A rejected (by code + reasoning):** `sesh new --target mysystem:voice-bridge-pi` *launches* pi but its non-`--no-launch` path prints `launched in mysystem:voice-bridge-pi` and **does not emit the uuid** (`internal/cli/new.go` calls `placeCommand`, not `printJSON`). So variant B (`--no-launch` + we run `launch` ourselves) is the one that gives a deterministic uuid AND keeps voice's hardened spawn (remain-on-exit + pi-error capture).

## Surprises / gotchas

- **Killing the session leaves a stale socket.** After `tmux kill-session` (pi gone, no orphan) the socket file lingered and `connect()` → `ECONNREFUSED`. pi does not unlink its socket on death, and `sesh delete` "does not touch the agent". → relies on the poller's existing stale-socket cleanup (≥2 failed probes + old mtime → unlink). No new code needed, but confirms that handling is load-bearing.
- `sesh delete <uuid>` removes the record only (not the agent/process) — fine for our spawn flow.

## Production implications

- Generalize `server/src/tmux/spawn.ts`: accept the command-to-run (the sesh `launch` string, run as-is) and an optional `expectSocketBasename` (the uuid) → wait for that exact socket. Keep bare-`pi` + snapshot-diff as the no-sesh fallback.
- `/api/sessions/spawn` (+ auto-spawn in `/api/sessions/default`): `registerPiSession()` → run `launch` via the generalized spawn → wait for `<uuid>.sock`. Tag `voice`.

## Artifacts
- [`run.sh`](run.sh) — full spawn→wait→verify→cleanup probe.
