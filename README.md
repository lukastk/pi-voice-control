# Voice Agent Bridge

Speak to your Pi sessions running in `tmux -L mysystem`. Web UI shows the live tmux pane (via wterm), a session picker, and a voice-prompt editor. LiveKit handles browser audio. See `PLAN.md` for the full design.

## Requirements

- Bun ≥ 1.3
- Node ≥ 20
- `tmux`, `livekit-server`, `pi`
- The `rpc-socket` Pi extension (auto-discovered if installed under `~/.pi/agent/extensions/`)

## First run

```bash
bun install
bin/start.sh
```

Open http://localhost:7890.

## Tailscale / phone access

The server binds `0.0.0.0` on ports 7890 (HTTP) and 7891 (wterm), plus livekit-server on 7880. On Tailnet, all three are reachable at `<tailnet-name>:<port>`.

On Android Chrome, opening `http://<tailnet-name>:7890` gives an "Add to Home screen" prompt — the app installs as a PWA. **Caveat:** Android Chrome PWAs cannot run audio with the screen off. For pocket use, build the Android wrapper at `android/` (Phase 8 — a thin Kotlin WebView with a microphone foreground service).

## Layout

| Path | Role |
|---|---|
| `server/` | Bun HTTP server: REST, SSE, wterm WS, LiveKit token, session poller |
| `worker/` | LiveKit agent worker (explicit dispatch) |
| `client/` | React UI (4 tabs: Terminal, Sessions, Voice prompt, Settings) |
| `bin/start.sh` | Boots livekit-server, server, worker |

## Phases

Tracked in `PLAN.md`. Phase 0 (scaffolding) is the current state.
