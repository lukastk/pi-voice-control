# Voice Agent Bridge

Talk to your Pi sessions running in `tmux` from a phone or browser. The repo is a small constellation: a Bun HTTP server, a LiveKit voice worker, a React UI, an embedded terminal renderer (`wterm`), and a thin Android wrapper for screen-off voice.

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

## Requirements

- **Bun** ≥ 1.3 and **Node** ≥ 20
- **`tmux`**, **`livekit-server`** (binary on PATH), **`pi`** (the AI coding agent)
- The **`rpc-socket`** Pi extension installed under `~/.pi/agent/extensions/`
- For voice: API keys (see [env vars](#env-vars)). Minimum useful set is `OPENAI_API_KEY` (STT) + `ELEVENLABS_API_KEY` (TTS), or `DEEPGRAM_API_KEY` instead of OpenAI for streaming STT.

## Quickstart

```bash
bun install
export OPENAI_API_KEY=...      # or DEEPGRAM_API_KEY
export ELEVENLABS_API_KEY=...
bin/start.sh
```

`bin/start.sh` boots three processes: `livekit-server --dev` on 7880, the LiveKit voice worker, and the Bun HTTP server on 7890. Open `http://localhost:7890`.

Pi sessions are not owned by this repo. Start them separately:

```bash
tmux -L mysystem new -s work -d  'cd ~/your-project && pi'
```

The rpc-socket extension exposes a Unix socket per Pi process under `/tmp/pi-rpc-sockets/`; the Sessions tab polls for them automatically.

## Turn modes

Voice can be driven three different ways. Switch modes in the Settings tab or via the `VAD`/`PTT`/`KW` badge in the top bar.

| Mode | What it does | Best for |
|---|---|---|
| **VAD** (default) | Auto-commits a turn after ~550 ms of silence | Quick back-and-forth, hands-free |
| **Manual (PTT)** | Tap a button to start/stop recording | Noisy environments |
| **Keyword** | Speak a wake phrase to start ("Pi, come in") and another to send ("Pi, that's all") | Long messages, walking around, dictation |

### Keyword mode

| Phrase (defaults) | Action |
|---|---|
| "Pi, come in" | Start a new message (arms the mic) |
| "Pi, that's all" | Send the message |
| "Pi, scrap that" | Discard the in-flight message |
| "Pi, do over" | Discard and re-arm |
| "Pi, say again" | Re-speak the last reply (only when idle) |
| "Pi, abort" | Stop whatever Pi is doing right now |

All phrases are configurable (multiple alternates per slot, fuzzy-matched with Levenshtein similarity). Tunables in Settings:

- **VAD gating** — while disarmed, only forward audio to Deepgram when local Silero VAD detects speech, dropping idle Deepgram cost roughly 10–20×. Configurable preroll, hangover, threshold, and Silero internals.
- **Auto-scrap timeout** — if you arm a turn and walk away, auto-discard after N seconds (default 60). Critical because armed mode bypasses the gate.
- **Match threshold** — how loose the wake-phrase fuzzy match is (lower = more permissive, higher = fewer false triggers).

The same six actions are also exposed as on-screen buttons in the keyword-mode action bar — useful when you don't want to say anything out loud.

## UI tabs

- **Terminal** — embedded tmux renderer (`wterm`) showing whichever pane your active Pi session lives in. The "follow" toggle and "show this session" button control whether voice connects auto-switch the pane. Uses an iframe to a separate WS process on port 7891.
- **Sessions** — list of discovered Pi rpc-sockets. Click "Connect voice" to dispatch the worker against one.
- **Voice prompt** — a small markdown file (`~/.pi/agent/AGENTS.voice.md` by default) appended to Pi's system prompt at dispatch time. Use it for "speak in short paragraphs" / "always say tool names out loud" / project-specific guidance.
- **Settings** — STT/TTS provider + model, turn mode, keyword phrases, VAD gating, earcons (radio-etiquette tones — _over_, _copy_, _out_), mic device.
- **Test** — try STT and TTS without a Pi session; useful for sanity-checking API keys and voices.

## Tailscale + HTTPS (required for mobile mic)

Mobile browsers refuse `getUserMedia` on `http://` for any non-localhost host — that's a hard browser security policy. To use voice from a phone you need real HTTPS.

`tailscale serve` gives you a real cert for your Tailnet hostname automatically:

```bash
bin/tailscale-serve.sh         # serves 7890, 7880, 7891 over Tailscale HTTPS
bin/tailscale-serve.sh --off   # tear it all down
```

Then open `https://<your-tailnet-name>/` on your phone. Re-run after every `tailscale up` since serve config doesn't always survive reboots on macOS.

## Mobile clients

- **Browser PWA** — open the Tailscale URL on Android Chrome or iOS Safari, "Add to Home Screen". Caveat: Chrome PWAs can't keep audio running with the screen off.
- **Android wrapper** — at `android/`, ~250 lines of Kotlin. WebView around the same React UI, plus a native LiveKit Room and a `microphone | mediaPlayback` foreground service that survives screen-off and battery optimization. See [`android/README.md`](android/README.md). The wrapper supports a list of saved server URLs and a picker (long-press the top-right corner) so one phone can target multiple deployments (e.g. Mac + remote server).

## Multi-host deployment

You can run the server on as many machines as you like (a desktop, a remote workstation, a Raspberry Pi). Each instance owns its own `pi` sessions. The Android wrapper's URL picker is what lets a single phone hop between them. From the host's side there's no special config — just run `bin/start.sh` and `bin/tailscale-serve.sh` on each machine. The Tailnet hostname for each ends up in the picker.

## Layout

| Path | Role |
|---|---|
| `bin/start.sh` | Local dev supervisor — boots livekit-server, worker, server |
| `bin/tailscale-serve.sh` | Configures `tailscale serve` for HTTPS |
| `server/` | Bun HTTP server: REST, SSE, session poller, LiveKit token, prompt injection |
| `worker/` | LiveKit agent worker — Pi RPC bridge, STT/TTS, keyword detection, VAD-gated STT wrapper |
| `client/` | React UI (Vite). Tabs in `client/src/tabs/`, two transports (`web-transport.ts` for browsers, `native-transport.ts` for the Android wrapper) |
| `wterm/` | Standalone Node + xterm.js process that PTYs into tmux and serves the terminal UI on port 7891 |
| `android/` | Android wrapper — see [`android/README.md`](android/README.md) |
| `scratch/` | Research artifacts: STT/TTS/VAD comparisons, voice API deep-dives |

## Env vars

| Var | For |
|---|---|
| `OPENAI_API_KEY` | Whisper STT (batch); also fallback TTS |
| `DEEPGRAM_API_KEY` | Streaming STT (recommended for keyword mode) |
| `ELEVENLABS_API_KEY` | TTS (highest quality). Mirrored to `ELEVEN_API_KEY` automatically |
| `CARTESIA_API_KEY` | Alternative TTS (lowest TTFB) |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Override the dev defaults if pointing at a hosted LiveKit instance |
| `PORT` / `BIND` | HTTP server port (default 7890) and bind address (default 0.0.0.0) |
| `WTERM_PORT` | wterm port (default 7891) |

User config (turn mode, voice provider/model, keyword phrases, VAD knobs, etc.) is persisted in `~/.config/voice-agent-bridge/config.json` and edited from the Settings tab.

## Logs

- `/tmp/voice-bridge-worker.log` — worker diagnostics (the LiveKit framework forks each job, so this is the only reliable place to see per-session events)
- `/tmp/voice-agent-bridge-livekit.log` — livekit-server stdout/stderr
- Browser console — client-side voice transport events
- `adb logcat | grep VoiceBridge` — Android wrapper bridge
