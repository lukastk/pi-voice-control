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

### Tailscale + HTTPS (required for mobile microphone)

Mobile browsers refuse `getUserMedia` (microphone) on `http://` for any non-localhost host — that's a hard browser security policy, no flag fixes it. You need real HTTPS to use voice from a phone.

The simplest fix is `tailscale serve`, which gives you a real cert for your Tailnet hostname automatically. From the repo root:

```bash
bin/tailscale-serve.sh         # serves 7890, 7880, 7891 over Tailscale HTTPS
bin/tailscale-serve.sh --off   # tear it all down
```

Then open `https://<your-tailnet-name>/` on your phone — Connect voice will work. The same script is what you'd run after every `tailscale up` since serve config doesn't always survive reboots on macOS.

If voice still fails with "Microphone access requires HTTPS on remote hosts", the script either didn't run or `tailscale serve status` shows nothing. Check with `tailscale serve status` and re-run the script.

### Android Chrome PWA

Opening `https://<tailnet>/` on Android Chrome gives an "Add to Home screen" prompt — the app installs as a PWA. **Caveat:** Android Chrome PWAs cannot run audio with the screen off. For pocket use, build the Android wrapper at `android/` (Phase 8 — a thin Kotlin WebView with a microphone foreground service).

## Layout

| Path | Role |
|---|---|
| `server/` | Bun HTTP server: REST, SSE, wterm WS, LiveKit token, session poller |
| `worker/` | LiveKit agent worker (explicit dispatch) |
| `client/` | React UI (4 tabs: Terminal, Sessions, Voice prompt, Settings) |
| `bin/start.sh` | Boots livekit-server, server, worker |

## Phases

Tracked in `PLAN.md`. Phase 0 (scaffolding) is the current state.
