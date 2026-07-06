## What This Is

A voice conversation bridge for Pi coding agent sessions — speak to your Pi sessions running in tmux from a phone or browser. Multi-process architecture built around LiveKit for voice transport: a Bun HTTP server, a LiveKit agent worker, a React UI, an embedded terminal renderer (wterm), and a thin Android wrapper for screen-off voice.

```
┌──────────────────────────────────┐         ┌────────────────────────┐
│  Browser / Android wrapper       │         │  tmux -L mysystem      │
│  ┌────────────────────────────┐  │         │  ┌──────────────────┐  │
│  │ React UI (Sessions / Term  │  │         │  │ pi (rpc-socket)  │  │
│  │  / Prompt / Settings)      │  │         │  │ pi (rpc-socket)  │  │
│  └────────────────────────────┘  │         │  └──────┬───────────┘  │
│  ┌────────────────────────────┐  │         │         │ unix sockets │
│  │ LiveKit transport          │◀─┼─audio───┼─┐       ▼              │
│  │   (web SDK / native SDK)   │  │         │ │  /tmp/pi-rpc-sockets │
│  └────────────────────────────┘  │         │ │                      │
└──────────┬───────────────────────┘         │ │  ┌────────────────┐  │
           │ HTTPS (Tailscale)                 │ │  │ wterm (tmux pty│  │
           ▼                                   │ │  │  WebSocket UI) │  │
┌──────────────────────────────┐  ──REST/SSE──▶│ │  └────────────────┘  │
│  server/  (Bun, port 7890)   │               │ │                      │
│  ─ session poller            │  ──dispatch──▶│ │  ┌────────────────┐  │
│  ─ wterm switch (port 7891)  │               │ │  │ worker/        │  │
│  ─ LiveKit token / dispatch  │               │ └──│  LiveKit agent │  │
│  ─ Pi prompt injection       │               │    │  STT/TTS/Pi RPC│  │
└──────────────────────────────┘               └────┴────────────────┘
```

You start `pi` sessions yourself in tmux. The server discovers them via the `rpc-socket` extension; you pick one in the UI; the worker connects, transcribes your voice, sends it to that Pi session, and speaks the reply back.

The socket directory stays the source of truth for liveness, but when the user's [`sesh`](https://github.com/lukastk/sesh) session manager is available it's layered on top (config `sesh.{enabled,bin}`): discovered sockets are enriched with the sesh name/tags/status (joined by `sessionId === sesh uuid`), and "spawn" goes through `sesh new --agent pi` so voice-created sessions are registered/named/visible in sesh. Both degrade cleanly if sesh is missing. See `_dev/experiments/` for the derisking findings.

## Requirements

- **Bun** ≥ 1.3 and **Node** ≥ 20
- **`tmux`**, **`livekit-server`** (binary on PATH), **`pi`** (the AI coding agent)
- The **`rpc-socket`** Pi extension installed under `~/.pi/agent/extensions/`
- *(optional)* **`sesh`** on PATH for session enrichment + `sesh new` spawn (degrades gracefully without it)
- For voice: API keys (see Env vars). Minimum useful set is `OPENAI_API_KEY` (STT) + `ELEVENLABS_API_KEY` (TTS), or `DEEPGRAM_API_KEY` instead of OpenAI for streaming STT.

## Common Commands

```bash
# Install dependencies
bun install

# Full local dev (starts livekit-server, worker, HTTP server)
bin/start.sh

# Start individual components
cd server && bun run dev       # Bun HTTP server on port 7890 (--hot)
cd worker && bun run dev       # LiveKit agent worker (tsx, dev mode)
cd client && bun run dev       # Vite dev server for React UI

# Build client (for production serving)
cd client && bun run build

# Build wterm bundle (needed before first run)
cd wterm && bun run build

# Build / compile-check the Android wrapper (no `java` on PATH — use the JDK
# bundled with Android Studio and the user's Android SDK).
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd android && ./gradlew :app:compileDebugKotlin :app:processDebugResources  # fast compile + layout check
cd android && ./gradlew assembleDebug                                       # full APK

# Tailscale HTTPS (required for mobile mic)
bin/tailscale-serve.sh         # Serve UI on HTTPS 443 (from localhost:7890), plus 7891 (wterm) + 7880 (LiveKit)
bin/tailscale-serve.sh --off   # Tear down
```

## Project Structure

| Path | Role |
|------|------|
| `bin/start.sh` | Local dev supervisor — boots livekit-server, worker, server |
| `bin/tailscale-serve.sh` | Configures `tailscale serve` for HTTPS |
| `bin/tailscale-address.sh` | Retrieves the Tailnet HTTPS URL |
| `server/` | Bun HTTP server (Hono): REST, SSE, session poller, LiveKit token, prompt injection |
| `worker/` | LiveKit agent worker — Pi RPC bridge, STT/TTS, keyword detection, VAD-gated STT wrapper |
| `client/` | React UI (Vite). Tabs in `client/src/tabs/`, two transports (`web-transport.ts` for browsers, `native-transport.ts` for the Android wrapper) |
| `wterm/` | Standalone Node + `@wterm` process (built on `@wterm/core` + `@wterm/dom`; sets PTY term type to `xterm-256color`) that PTYs into tmux and serves the terminal UI on port 7891 |
| `android/` | Android wrapper — WebView + native LiveKit Room + foreground service for screen-off voice |

### Server (`server/`)

Bun HTTP server using Hono. Entry: `server/src/main.ts`. Key modules:
- `server/src/sessions/` — Pi session discovery via rpc-socket polling; `sesh.ts` enriches sockets with sesh metadata and spawns via `sesh new` (best-effort; `sesh.bin` should be an ABSOLUTE path — under supervisord `~/go/bin` often isn't on PATH)
- `server/src/livekit.ts` — LiveKit token generation and worker dispatch
- `server/src/prompt/` — Voice prompt injection (`default.ts`/`file.ts`/`inject.ts`; reads `~/.pi/agent/AGENTS.voice.md`)
- `server/src/tmux/` — Tmux integration (`focus.ts` pane switching, `spawn.ts` spawns a fresh Pi session in a tmux window)
- `server/src/term/` — wterm (embedded terminal) management
- `server/src/voice/` — REST clients for the STT/TTS test endpoints (`/api/test/stt`, `/api/test/tts`)
- `server/src/events/` — SSE event streaming
- `server/src/state.ts` — In-memory server state
- `server/src/util/` — Shared server utilities
- `server/src/http.ts` — REST API routes
- `server/src/config/` — Server configuration

### Worker (`worker/`)

LiveKit agent using `@livekit/agents`. Entry: `worker/src/agent.ts`. Uses:
- `@livekit/agents-plugin-deepgram` — streaming STT (primary, recommended for keyword mode)
- `@livekit/agents-plugin-openai` — batch STT (Whisper)
- `@livekit/agents-plugin-elevenlabs` — TTS (highest quality)
- `@livekit/agents-plugin-cartesia` — TTS (lowest TTFB)
- `@livekit/agents-plugin-silero` — local VAD for keyword-mode gating

Worker diagnostic log: `/tmp/voice-bridge-worker.log`

### Client (`client/`)

React + Vite SPA. Two transport backends:
- `client/src/web-transport.ts` — browser: LiveKit web SDK
- `client/src/native-transport.ts` — Android wrapper: LiveKit native SDK via bridge

UI tabs in `client/src/tabs/`: Terminal, Sessions, Voice prompt (`PromptTab`), Settings, Test.

## Turn Modes

Voice can be driven three different ways. Switch modes in the Settings tab or via the `VAD`/`PTT`/`KW` badge in the top bar.

| Mode | What it does | Best for |
|------|-------------|---------|
| **VAD** (default) | Auto-commits a turn after ~550 ms of silence | Quick back-and-forth, hands-free |
| **Manual (PTT)** | Tap a button (or the notification play/pause) to start/stop; commit happens on mic-mute, with start/stop earcons | Noisy environments |
| **Keyword** | Speak a wake phrase to start ("Pi, come in") and another to send ("Pi, that's all") | Long messages, walking around, dictation |

Switching modes always reconnects the session (worker `turnDetection` is fixed at session start). **Barge-in** (`voice.interruptOnTurnStart`, default on): starting a turn (keyword arm / PTT unmute) stops the agent's in-progress TTS + aborts its Pi turn so it doesn't talk over you; VAD already interrupts on speech.

### Keyword mode phrases (configurable)

| Phrase (defaults) | Action |
|-------------------|--------|
| "Pi, come in" | Start a new message (arms the mic) |
| "Pi, that's all" | Send the message |
| "Pi, scrap that" | Discard the in-flight message |
| "Pi, do over" | Discard and re-arm |
| "Pi, say again" | Re-speak the last reply (only when idle) |
| "Pi, abort" | Stop whatever Pi is doing right now |

Keyword mode uses fuzzy matching with Levenshtein similarity. Configurable: VAD gating (Silero VAD speech detection to reduce idle Deepgram cost ~10–20×), auto-scrap timeout (default 60s), and match threshold.

## Env Vars

| Var | For |
|-----|-----|
| `OPENAI_API_KEY` | Whisper STT (batch); also fallback TTS |
| `DEEPGRAM_API_KEY` | Streaming STT (recommended for keyword mode) |
| `ELEVENLABS_API_KEY` | TTS (highest quality). Mirrored to `ELEVEN_API_KEY` automatically |
| `CARTESIA_API_KEY` | Alternative TTS (lowest TTFB) |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice (default `CwhRBWXzGAHq8TQ4Fs17`) |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Override the dev defaults (`ws://localhost:7880`, `devkey`, `secret`) |
| `PORT` / `BIND` | HTTP server port (default 7890) and bind address (default 0.0.0.0) |
| `WTERM_PORT` | wterm port (default 7891) |
| `SKIP_CLIENT_BUILD` | Set to `1` to skip client rebuild on start (for fast restarts) |
| `REINSTALL` | Set to force `bun install` on start |

User config (turn mode, voice provider/model, keyword phrases, VAD knobs, barge-in `voice.interruptOnTurnStart`, `sesh.{enabled,bin}`, etc.) is persisted in `~/.config/voice-agent-bridge/config.json`. Missing keys are filled from defaults on load.

## Logs

- `/tmp/voice-bridge-worker.log` — worker diagnostics (the LiveKit framework forks each job, so this is the only reliable place to see per-session events)
- `/tmp/voice-agent-bridge-livekit.log` — livekit-server stdout/stderr
- Browser console — client-side voice transport events
- `adb logcat | grep VoiceBridge` — Android wrapper bridge

## Tailscale + HTTPS

Mobile browsers refuse `getUserMedia` on `http://` for any non-localhost host. `tailscale serve` provides a real cert for your Tailnet hostname:

```bash
bin/tailscale-serve.sh         # serves UI on HTTPS 443 (from localhost:7890), plus 7891 (wterm) + 7880 (LiveKit)
bin/tailscale-serve.sh --off   # tear it all down
```

Then open `https://<your-tailnet-name>/` on your phone. Re-run after every `tailscale up` since serve config doesn't always survive reboots on macOS.

## Mobile Clients

- **Browser PWA** — open the Tailscale URL on Android Chrome or iOS Safari, "Add to Home Screen". Chrome PWAs can't keep audio running with the screen off.
- **Android wrapper** — at `android/`. WebView around the same React UI, plus a native LiveKit Room and a `microphone | mediaPlayback` foreground service that survives screen-off and battery optimization. Supports multiple server URLs via a picker (long-press the top-right corner). The foreground service owns a `MediaSession` + MediaStyle notification, so the **lock-screen/notification play-pause** starts/stops a turn (icon reflects state). Selecting a **Bluetooth mic** routes via `AudioManager.setCommunicationDevice` (from `availableCommunicationDevices`) — `setPreferredInputDevice` alone never activates the SCO link; needs `BLUETOOTH_CONNECT`. Note: while the BT mic (SCO/call mode) is active, **hardware buttons can't control the turn** — earbud taps become call-controls and volume keys aren't dispatched to apps screen-off (verified dead ends; see git history / `_dev/experiments/03`).

## Multi-Host Deployment

You can run the server on as many machines as you like. Each instance owns its own `pi` sessions. The Android wrapper's URL picker lets a single phone hop between them. From the host's side: run `bin/start.sh` and `bin/tailscale-serve.sh` on each machine.

## Conventions

- **No linter configured** — TypeScript strict mode is the primary guardrail
- **Bun** for the HTTP server (Hono), **tsx** for the worker (LiveKit agents ecosystem is Node.js-oriented)
- **Vite** for the client build
- `start.sh` is the root entry point; it forwards to `bin/start.sh`
- Pi sessions are NOT owned by this repo — they must be started separately in `tmux -L mysystem`
