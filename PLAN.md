# Voice Agent Bridge — Implementation Plan

Updated: 2026-05-02. Supersedes the prior plan; the mockup at `_dev/mockups/livekit-pi-tmux-rpc/` is now treated as reference-only.

---

## 0. Scope in one paragraph

Build a single self-hosted server that lets one user speak to whichever Pi session they have running in `tmux -L mysystem`, while also showing that session live in a wterm-rendered terminal. The same web UI exposes a session picker (auto-discovered every few seconds via Pi's `rpc-socket` extension), a voice system-prompt editor, and a settings panel. The browser client is reachable on Tailscale; on Android a thin native WebView wrapper with a foreground service keeps voice running with the screen off. LiveKit is the audio transport. The voice path uses `<spoken>` tag extraction over the rpc-socket event stream, with three short earcons signalling end-of-user-turn, start-of-agent-turn, and end-of-agent-turn.

---

## 1. High-level architecture

```
┌────────────── Browser / Android WebView ──────────────┐
│  React UI                                             │
│   ├─ Tab bar (slim, top): Terminal • Sessions •       │
│   │            Voice prompt • Settings                │
│   ├─ Terminal tab: <wterm> full-screen + extra-keys   │
│   ├─ Sessions tab: list of live Pi sessions           │
│   ├─ Voice prompt tab: editor for AGENTS.voice.md     │
│   └─ Settings tab: config form                        │
│                                                       │
│  LiveKit Web SDK (audio in/out, data channel)         │
│  WebSocket /ws/term  (wterm pty stream)               │
│  EventSource /events (server status, sessions)        │
│  REST /api/*         (CRUD)                           │
└──────────────────────┬────────────────────────────────┘
                       │ Tailscale (encrypted)
┌──────────────────────┴────────────────────────────────┐
│  Bun process — voice-agent-bridge                     │
│   ├─ HTTP server (Hono on Bun)                        │
│   │   ├─ Static UI bundle                             │
│   │   ├─ REST /api/*                                  │
│   │   ├─ EventSource /events                          │
│   │   ├─ WebSocket /ws/term  (per-client tmux pty)    │
│   │   └─ LiveKit token endpoint                       │
│   ├─ Session manager                                  │
│   │   ├─ Polls /tmp/pi-rpc-sockets/*.sock every 2s    │
│   │   ├─ Liveness probe + getState{} per socket       │
│   │   └─ Maintains current voice target               │
│   ├─ Voice prompt store                               │
│   │   ├─ Reads/writes AGENTS.voice.md                 │
│   │   └─ Re-injects on session switch / edit          │
│   ├─ Earcon mixer (server-side PCM clips)             │
│   ├─ Config store (~/.config/voice-agent-bridge/)     │
│   └─ Dispatcher → LiveKit AgentDispatchClient         │
│                                                       │
│  Subprocesses                                         │
│   ├─ livekit-server --dev (separate binary)           │
│   └─ Voice agent worker (npm script, agentName-mode)  │
└──────────────────────┬────────────────────────────────┘
                       │ Unix socket JSONL
        ┌──────────────┴──────────────┐
        │  Pi sessions you already    │
        │  run in tmux -L mysystem    │
        │  (rpc-socket extension      │
        │   exposes one socket each)  │
        └─────────────────────────────┘
```

Three running services we own: **the Bun server**, **livekit-server**, **the voice agent worker**. Pi sessions are *not* owned by us — we attach to whatever the user already has running in `tmux -L mysystem`. A start script wraps all three; the voice worker is dispatched on demand, not auto.

---

## 2. Repo layout

```
voice-agent-bridge/
├── PLAN.md                         (this file)
├── AGENTS.md                       (project context for AI)
├── README.md                       (run instructions)
├── package.json                    (Bun + workspaces)
│
├── bin/
│   └── start.sh                    (boots livekit-server, server, worker)
│
├── server/                         (the Bun process)
│   ├── src/
│   │   ├── main.ts                 (entry, wires everything)
│   │   ├── http.ts                 (Hono app, routes)
│   │   ├── config.ts               (load/save ~/.config/voice-agent-bridge/)
│   │   ├── livekit.ts              (token gen, dispatch client)
│   │   ├── sessions/
│   │   │   ├── poller.ts           (filesystem + getState polling)
│   │   │   ├── socket-client.ts    (one rpc-socket connection)
│   │   │   └── store.ts            (in-memory state of all sessions)
│   │   ├── prompt/
│   │   │   ├── file.ts             (read/write AGENTS.voice.md)
│   │   │   └── inject.ts           (clearSystemPrompt + appendSystemPrompt)
│   │   ├── term/
│   │   │   ├── wterm-server.ts     (WS /ws/term + node-pty)
│   │   │   └── focus.ts            (tmux switch-client logic)
│   │   ├── api/
│   │   │   ├── sessions.ts         (REST handlers)
│   │   │   ├── prompt.ts
│   │   │   ├── config.ts
│   │   │   └── events.ts           (SSE stream)
│   │   └── earcons/
│   │       ├── clips.ts            (load wav files)
│   │       └── publisher.ts        (publish into LiveKit)
│   ├── assets/
│   │   └── earcons/                (over.wav, copy.wav, out.wav)
│   └── package.json
│
├── worker/                         (LiveKit agent worker — separate proc)
│   ├── src/
│   │   ├── agent.ts                (defineAgent + llmNode override)
│   │   ├── pi-bridge.ts            (PiSocket lifted out of mockup)
│   │   ├── spoken-tag.ts           (parser, lifted from mockup)
│   │   ├── speech-chunker.ts       (fallback chunker, lifted)
│   │   └── earcons.ts              (publishes pre-loaded PCM)
│   └── package.json
│
├── client/                         (web UI — Vite + React)
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx                 (tab shell)
│   │   ├── tabs/
│   │   │   ├── TerminalTab.tsx     (wterm host, extra-keys row)
│   │   │   ├── SessionsTab.tsx
│   │   │   ├── PromptTab.tsx
│   │   │   └── SettingsTab.tsx
│   │   ├── livekit.ts              (room connect, data channel)
│   │   ├── api.ts                  (REST + SSE clients)
│   │   ├── pwa-manifest.json
│   │   └── service-worker.ts
│   └── public/
│       └── icons/
│
└── android/                        (deferred; thin WebView wrapper)
    ├── app/
    │   └── src/main/...
    └── build.gradle
```

Three packages in one repo (Bun workspaces). Worker is separate from server because LiveKit's CLI takes over the process (registers as a worker, blocks). Client is a React SPA so the tab UI stays maintainable.

---

## 3. Component design

### 3.1 The Bun server

One process, Hono framework on Bun's native HTTP. Responsibilities:

| Concern | Endpoint(s) | Notes |
|---|---|---|
| Serve UI | `GET /` and static assets | Vite-built bundle copied at deploy |
| Auth (light) | header `X-Voice-Token` | Single shared token, set in config; OK on Tailnet |
| LiveKit token | `POST /api/livekit/token` | Returns JWT for browser to join room |
| Session list | `GET /api/sessions` | Snapshot of poller's store |
| Session switch | `POST /api/sessions/select` | Body: `{ socketPath }` — sets voice target, follows wterm |
| Session actions | `POST /api/sessions/:id/abort` | Forwards to socket `{abort:true}` |
| Voice prompt | `GET/PUT /api/prompt` | Reads/writes the file, re-injects on PUT |
| Config | `GET/PUT /api/config` | Reads/writes JSON |
| Events stream | `GET /events` (SSE) | Sessions snapshot, voice state, errors |
| wterm pty | `GET /ws/term` (WebSocket) | Spawns `tmux -L <socket> attach` per client |

**No business logic in handlers** — they call into `sessions/store`, `prompt/file`, `term/focus`, etc. That keeps testing tractable.

### 3.2 Session manager / poller

This is the heart. State it owns:

```ts
type PiSession = {
  socketPath: string;          // /tmp/pi-rpc-sockets/<uuid>.sock
  sessionId: string;           // uuid (filename minus .sock)
  alive: boolean;
  lastSeen: number;
  cwd: string | null;          // Pi's process.cwd() — used for folder-based selection
  state: {
    idle: boolean;
    contextUsage: number | null;
    hasAppendedSystemPrompt: boolean;
  };
  tmux: {
    inTmux: boolean;
    session?: string;
    window?: string;
    windowIndex?: number;
    paneIndex?: number;
    paneId?: string;           // %5
  };
};
```

**Poller loop** (every `config.pollIntervalMs`, default 2000):

1. `readdir(SOCKETS_DIR)` filtered to `*.sock`.
2. For each socket not currently in store, open a short-lived connection. Send `{getState:true}`. If we get `{ok:true,state:{...}}` within 1s: alive. Else: stale (delete file if older than N seconds).
3. For sockets already in store, reuse a long-lived subscriber connection (see below) and rely on a heartbeat ping (`getState` every 10s) instead of reopening.
4. Mark `alive=false` for sockets that disappeared from the directory and weren't gracefully closed; remove after grace period.
5. Emit `sessions:update` on the EventSource bus when the snapshot changes.

**Per-session connection**: we keep one persistent rpc-socket connection per *known* session, even when it isn't the voice target, used for heartbeats and getState. The *voice* connection (which sends messages and subscribes to events) is a second connection opened on demand by the worker. This avoids the worker holding state about every session.

**Stale socket cleanup**: rpc-socket README confirms sockets linger after a SIGKILL. Cleanup rule: if the file exists, fails liveness probe twice in a row, and is older than 30s, `unlink` it.

**Folder matching for default-session selection**: requires the rpc-socket extension to expose `state.cwd` (`process.cwd()`). The extension is owned by the user and lives at `~/mysetup/myagent/extensions/rpc-socket/`; this plan assumes the cwd field is added there. Existing Pi sessions need `/reload` to pick up the new field; new ones get it automatically. Match rule: `fs.realpathSync(state.cwd) === fs.realpathSync(config.startup.defaultFolder)`. Realpath both sides so symlinks (`~`, `/Volumes/...`, etc.) compare correctly. If multiple sessions match, prefer the most recently active (largest `lastSeen`).

### 3.3 Voice prompt management

**File location**: `~/.pi/agent/AGENTS.voice.md` by default; configurable. Sits beside the user's existing `AGENTS.md`, which Pi loads automatically (the `--no-context-files` flag controls *both*, so we don't disable it).

**Pi already merges your AGENTS.md at startup** via its normal context-file discovery. The voice file is *not* a Pi context file; it's an *appended system prompt* that we inject through the rpc-socket extension on every turn (the extension's `before_agent_start` hook concatenates it onto the system prompt). So behaviour is:

- Pi startup → AGENTS.md loaded into base system prompt (Pi's normal flow).
- Server connects to socket → sends `{appendSystemPrompt: <file contents>}`.
- Every turn → extension prepends both into the effective prompt.

**Crucial subtlety**: `appendSystemPrompt` *replaces* the appended text, doesn't accumulate (line 284 of rpc-socket/index.ts). So we don't need `clearSystemPrompt` before appending — re-sending `appendSystemPrompt` is idempotent and atomic. We do call `clearSystemPrompt` only when the user explicitly disables voice mode in the UI.

**On switch / on edit**: write through these steps:

1. UI PUTs `/api/prompt` with new body.
2. Server writes file.
3. Server sends `{appendSystemPrompt: <body>}` to *current voice target* socket.
4. SSE pushes `prompt:updated` so other clients refresh.
5. On voice-target switch (`POST /api/sessions/select`), re-inject to the new target — and clear from the old target if config flag `clearOnSwitch=true` (default true).

**Default contents** (written on first run if file missing): the spoken-tag prompt from the mockup, plus radio-etiquette guidance.

### 3.4 LiveKit voice pipeline

**Why LiveKit and not the original custom WebSocket plan**: the mockup proved LiveKit's WebRTC handles iOS/Android echo cancellation and microphone permissions out of the box; replicating that in raw WebSocket + AudioWorklet was the largest unsolved problem in the prior plan.

**Worker model**: explicit dispatch (`agentName: "voice-bridge"` in `ServerOptions`). Auto-dispatch is disabled. The Bun server creates dispatches via `AgentDispatchClient.createDispatch(roomName, "voice-bridge", { metadata: JSON.stringify({ socketPath }) })`. This eliminates the start-order race the mockup had to paper over with a 5-second sleep.

**Per-room metadata** carries the chosen `socketPath`. The worker reads `ctx.job.metadata` in `entry()` and connects to that socket. No env-var passing.

**Pipeline plugins** (initial): Deepgram for STT (`@livekit/agents-plugin-deepgram` Nova-3), Cartesia for TTS (`@livekit/agents-plugin-cartesia` Sonic-3), Silero VAD (`@livekit/agents-plugin-silero`). ElevenLabs and OpenAI Whisper kept as configurable fallbacks. STT/TTS provider selection comes from `config.json`; the worker reads it on startup.

**Override `Agent.llmNode()`** as the mockup does. Behaviour preserved verbatim:

- Spoken-tag parser feeds completed `<spoken>` contents to TTS.
- Tool-status messages on `tool_execution_start`.
- "Still working." keepalive after 7s of tool silence.
- Cleaned-text fallback if no tags appear.
- Steer-vs-prompt logic stays (note: extension delivers both as steer internally, but distinguishing matters for the duplicate-call guard).

**Stream cancellation** (`cancel()` callback): keep the mockup's policy — abandon the LLM stream but don't `abort` the Pi socket. User interruption maps to the next voice turn becoming a steer.

### 3.5 Earcons

Three short clips (80–150 ms each), pre-rendered as 24 kHz mono PCM:

| Trigger | File | Phonetic intuition |
|---|---|---|
| End-of-user-turn (final transcript) | `over.wav` | short rising "blip" |
| Start-of-agent-turn (first text emitted) | `copy.wav` | short two-tone "ack" |
| End-of-agent-turn (`agent_end` event) | `out.wav` | short falling "blip" |

**Where played**: server-side, by the LiveKit worker, published into the agent's audio track. This means the browser receives them as part of the agent's WebRTC stream → AEC sees them as remote audio → no false barge-in. (If we played them on the browser via `<audio>`, AEC wouldn't see them and the speaker echo could trip Silero VAD.)

**How**: pre-load PCM buffers in the worker `prewarm`. Expose a `playEarcon(name)` function that pushes the buffer into the same audio sink the TTS uses — concretely, prepend the PCM to the next `controller.enqueue()` chunk in `llmNode`, or use LiveKit's `audio_play` source if a clean API exists. (Verification needed; if neither path is clean, we publish a separate short audio track per earcon and let the client mix.)

**Triggers**:

- `over`: on `AgentSession.UserInputTranscribed` with `final=true`. Fires before the prompt goes out.
- `copy`: on first non-empty `text_delta` (or first tool-status string) emitted in the current turn.
- `out`: on `agent_end`.

**Disable flag** in config: `earcons.enabled` (bool), `earcons.volume` (0–1), individual `earcons.over/copy/out` toggles.

### 3.6 wterm integration

**Reuse the supervisor's wterm setup almost verbatim** — the file is small and already mobile-friendly:

- `server/src/term/wterm-server.ts` clones `~/mysetup/myrig/home/^supervisor^.supervisor/scripts/wterm/server.mjs`.
- Same `\x1b[RESIZE:cols;rows]` escape sequence.
- Same `node-pty` spawn.
- Same `dist/client.js` build via esbuild on postinstall.
- The `extra-keys` bottom row (ESC/TAB/CTRL/ALT/arrows/font) is moved into the React `TerminalTab` component, preserving the `(pointer: coarse)` show/hide behaviour and the ctrl/alt latch logic.

**Single tmux client per browser tab**: `pty.spawn("tmux", ["-L", config.tmuxSocket, "attach"])`. wterm sends RESIZE on connect; pty resizes accordingly. Wheel + touch scroll → SGR mouse sequences (kept).

**Following the voice target**: when `POST /api/sessions/select` lands, the server runs `tmux -L <socket> switch-client -t <target>`. With one wterm client, this works without specifying `-c <client-name>`. If multiple wterm tabs are open at once, we switch the most recent client; if that proves wrong in practice, we fall back to tracking `client_pid` from `tmux list-clients` and passing `-c` explicitly.

`<target>` is constructed from session info: `"<sessionName>:<windowIndex>.<paneIndex>"`. (Session names with special chars are quoted.)

**Decoupling option**: the UI gets a "pin terminal to this session" toggle. Default off — wterm follows voice. When on, switch-client is suppressed.

### 3.7 Web UI

**Stack**: Vite + React + TypeScript. Tailwind for styling. No router needed (tabs only).

**Tab bar**: ~32px slim. Always visible (not just mobile). Tabs:

1. **Terminal** — full-height wterm. Bottom extra-keys row only on coarse pointers (kept from supervisor css). The wterm fills the area between the tab bar and the extra-keys row.
2. **Sessions** — list view, one row per discovered Pi session showing: cwd (the folder Pi is operating in), tmux session name, window/pane index, idle/busy state, context %, last seen, "Connect voice" + "Pin terminal" buttons. The current voice target is highlighted. Sessions whose cwd matches `config.startup.defaultFolder` are pinned to the top with a "default" badge. Pull-to-refresh issues a `POST /api/sessions/refresh` (which forces an immediate poll).
3. **Voice prompt** — a `<textarea>` filled with `AGENTS.voice.md`, Save button, "Re-inject now" button, dirty indicator, "Reset to default" button.
4. **Settings** — form for: tmux socket name (default `mysystem`), voice prompt file path, STT/TTS provider selection, voice ID (Cartesia/ElevenLabs), earcon toggles, polling interval, LiveKit URL/keys, **default folder** (absolute path; if a live Pi session is running there it auto-selects on UI startup, otherwise the server spawns one), `spawnIfMissing` toggle.

**State management**: a single Zustand store fed by:

- REST GET on mount.
- Long-lived EventSource (`/events`) for live updates: `sessions:update`, `prompt:updated`, `config:updated`, `voice:state`, `errors`.
- LiveKit Room events for voice-call status.

**Connecting voice**:

1. User clicks "Connect voice" on a session row.
2. Client calls `POST /api/sessions/select { socketPath }`.
3. Server picks/creates a LiveKit room name (e.g. `voice-<sessionId>`), creates a dispatch carrying the socket path as metadata, returns `{ roomName, token }`.
4. Client connects the LiveKit Room.
5. wterm follows via the server-side `switch-client`.

**Disconnect**: `POST /api/sessions/release` ends the dispatch (the worker will then leave the room). The Pi session keeps running.

**PWA**: standard manifest + a tiny service worker that caches the shell. Installable on Android and (decoratively) iOS. Real backgrounding is the WebView wrapper, not PWA.

### 3.8 Configuration

**File**: `~/.config/voice-agent-bridge/config.json`. Created with defaults on first run. Schema (TypeScript-ish):

```ts
type Config = {
  server: {
    port: number;                    // 7890
    bind: string;                    // "0.0.0.0" — Tailscale-routable
    authToken: string;               // generated on first run
  };
  tmux: {
    socketName: string;              // "mysystem"
  };
  pi: {
    socketsDir: string;              // "/tmp/pi-rpc-sockets"
    pollIntervalMs: number;          // 2000
    staleSocketAfterMs: number;      // 30000
  };
  prompt: {
    filePath: string;                // "~/.pi/agent/AGENTS.voice.md"
    clearOnSwitch: boolean;          // true
  };
  voice: {
    livekit: { url: string; apiKey: string; apiSecret: string };
    stt:  { provider: "deepgram" | "openai" | "groq"; ... };
    tts:  { provider: "cartesia" | "elevenlabs" | "say"; voiceId: string; ... };
    vad:  { provider: "silero"; minSilenceMs: number };
    earcons: { enabled: boolean; volume: number; over: boolean; copy: boolean; out: boolean };
  };
  startup: {
    defaultFolder: string | null;    // absolute path; null = no default (explicit pick)
    spawnIfMissing: boolean;         // true — start Pi in defaultFolder if no live session matches
  };
};
```

API keys live in env vars normally (never written to disk), but the config file *can* override. This way Tailscale-only users avoid leaking keys to disk.

### 3.9 Tailscale exposure

No code change. The Bun server binds to `0.0.0.0`. Mac is on Tailnet → `http://<mac-tailnet-name>:7890` works from any device on the tailnet. LiveKit dev server also binds 0.0.0.0 (`livekit-server --dev --bind 0.0.0.0`); the browser uses the same hostname for `ws://<mac-tailnet-name>:7880`.

**Watch-outs**:
- LiveKit dev mode is plaintext WS. On Tailnet that's acceptable since traffic is encrypted by Tailscale itself. Production-grade TLS is a future concern.
- Single-token URL gating prevents accidental access if the tailnet is shared.

### 3.10 Android wrapper (deferred to phase 8)

Native app shape (Kotlin):

- Single `Activity` with one `WebView` pointed at the configured URL.
- `Service` of type `microphone | mediaPlayback`. Persistent notification.
- Service acquires `PowerManager.PARTIAL_WAKE_LOCK`.
- WebView gets `WebChromeClient.onPermissionRequest` plumbing for `RECORD_AUDIO`.
- Manifest permissions: `INTERNET`, `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `WAKE_LOCK`, `MODIFY_AUDIO_SETTINGS`.
- App launches the foreground service before navigating the WebView, so the WebRTC PeerConnection lives inside a process that can't be silently killed.

Sideloaded APK; no Play Store.

---

## 4. Protocols and contracts (cheat sheet)

### 4.1 rpc-socket commands we use

```
{"subscribe":true}                     // worker, after connect
{"appendSystemPrompt":"<voice md>"}    // server, on switch / edit
{"clearSystemPrompt":true}             // server, on disconnect (optional)
{"getState":true}                      // server, on poll heartbeat — returns idle, contextUsage, cwd, tmux
{"abort":true}                         // server, exposed as session row action
{"message":"<user text>"}              // worker, voice prompts
```

**Streamed events we consume** (only for socket-initiated turns):
```
{"event":"text_delta","delta":"..."}
{"event":"tool_execution_start","toolName":"..."}
{"event":"tool_execution_end","toolName":"..."}
{"event":"agent_end"}
```

We do **not** use `{compact:true}` from the voice path (user controls compaction in the TUI).

### 4.2 Server REST + SSE

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/sessions` | — | `PiSession[]` |
| POST | `/api/sessions/refresh` | — | `PiSession[]` (forces poll) |
| POST | `/api/sessions/select` | `{socketPath}` | `{roomName, token}` |
| POST | `/api/sessions/release` | — | `{ok:true}` |
| POST | `/api/sessions/:id/abort` | — | `{ok:true}` |
| GET | `/api/prompt` | — | `{path, body, mtime}` |
| PUT | `/api/prompt` | `{body}` | `{ok:true}` |
| POST | `/api/prompt/reinject` | — | `{ok:true}` |
| GET | `/api/config` | — | `Config` |
| PUT | `/api/config` | `Partial<Config>` | `Config` |
| GET | `/events` | — | SSE stream |

SSE event types:

```
event: sessions:update     data: PiSession[]
event: voice:state         data: {state, target?, error?}
event: prompt:updated      data: {body, mtime}
event: config:updated      data: Config
event: error               data: {code, message}
```

### 4.3 LiveKit data channel

Used for low-latency UI updates that don't need the SSE/REST round trip:

| Direction | Topic | Payload |
|---|---|---|
| agent → browser | `transcript` | `{role:"user"|"assistant", text, final}` |
| agent → browser | `tool` | `{name, phase:"start"|"end"}` |
| agent → browser | `state` | `{state:"listening"|"thinking"|"speaking"}` |
| browser → agent | `interrupt` | `{}` (rare; mostly handled via VAD) |

Lossy by default. We don't ship audio earcon triggers over the data channel because earcons are mixed into the agent's audio track (§3.5).

### 4.4 wterm WebSocket

Same protocol as the supervisor's: binary or string frames pass through to/from the pty. Special control: `\x1b[RESIZE:<cols>;<rows>]` resizes the pty. No additional framing.

### 4.5 Voice prompt file

A markdown document. First-run default body:

```
# Voice mode instructions

Voice mode is active for messages that arrive through the voice/socket
bridge. Wrap anything that should be spoken aloud in <spoken> tags.

Use these tags liberally:
- Acknowledge the user's request immediately.
- Give brief status updates during long tool tasks.
- Summarize your final answer conversationally.

Keep <spoken> content conversational: no code, file paths, markdown,
raw URLs, or long technical detail.

Outside the tags, respond as usual. Example:
  <spoken>Sure, I'll check that now.</spoken>

Radio etiquette: keep voice acknowledgements short. The user hears
short tones at end-of-their-turn, start-of-yours, and end-of-yours.
```

---

## 5. Lifecycle scenarios

### 5.1 Cold start

Three sub-cases depending on `config.startup.defaultFolder`:

**5.1.a — No default folder configured.**

1. `./bin/start.sh` boots livekit-server, server, worker.
2. UI loads. Sessions tab shows whatever live sessions the poller found.
3. User clicks "Connect voice" on a session.
4. Server creates dispatch with socket path metadata; returns room+token.
5. Browser joins room. Worker job spawns, connects to socket, subscribes, injects voice prompt. Greeting plays.
6. wterm follows: server runs `tmux switch-client -t <target>`.

**5.1.b — Default folder configured, a live session matches.**

1. Server starts. Poller runs. For each live socket, server reads `state.cwd` from `getState`.
2. Server resolves `config.startup.defaultFolder` to a real absolute path (`fs.realpathSync` — handles symlinks).
3. First match by `realpath(cwd) === realpath(defaultFolder)` → that session becomes the pre-selected target.
4. UI loads → Sessions tab pre-highlights the matched row → user just clicks "Connect voice" (or, optionally, a `config.startup.autoConnect` flag connects automatically).
5. Same as 5.1.a from step 4.

**5.1.c — Default folder configured, no live session matches, `spawnIfMissing=true`.**

1. Server resolves `defaultFolder`.
2. No socket reports a matching cwd.
3. Server spawns: `tmux -L <socket> new-window -c <defaultFolder> 'pi …'` in a configurable target tmux session (default `mysystem` socket, session name from `config.tmux.spawnSessionName` — fallback to creating one if it doesn't exist).
4. Server waits up to 30 s for a new socket to appear in `/tmp/pi-rpc-sockets/`. Identifies the new one by diffing the socket-set before and after (same trick as the mockup's `start.sh`).
5. Polls the new socket's `state.cwd` to confirm match (sanity check).
6. Pre-selects that session. Continues as 5.1.b.

If `spawnIfMissing=false` and no match, the UI shows an info banner: "No Pi session running in `<defaultFolder>`. Start one with `cd <defaultFolder> && pi`, or change the default folder in settings."

### 5.2 Switching voice target while connected

1. User clicks "Connect voice" on a different session.
2. Client calls `POST /api/sessions/release` first (explicit teardown).
3. Server tells the worker the room is done (LiveKit's dispatch finishes), then creates a fresh dispatch for the new socket.
4. UI rejoins the new room (new token). Worker loads new socket, re-injects prompt.
5. wterm switches.

(Alternative: hot-swap inside the same room by sending a custom data message and having the worker swap its `PiSocket`. Simpler and lower-latency but the dispatcher pattern is cleaner. We pick the dispatcher pattern for v1; revisit if switch latency becomes annoying.)

### 5.3 Pi session dies mid-conversation

1. Worker's persistent socket emits `close`. Worker stops emitting tokens, plays an "out" earcon, sends a `state` data message `error`, and ends the LLM stream.
2. Server's heartbeat finds the socket dead; UI shows the session as inactive.
3. User picks a different live session or restarts Pi.

### 5.4 User types directly into the TUI while voice is connected

The rpc-socket extension's `currentTurnFromSocket` flag is *false* for typed turns. Worker sees no events for that turn — voice stays silent. wterm shows the typed conversation normally. This is exactly what we want.

### 5.5 Edit voice prompt during a turn

1. User edits, hits Save.
2. Server writes file → sends `appendSystemPrompt` → ack.
3. Pi's extension stores the new value; on the *next* turn it's used. The current in-flight turn is not affected.
4. UI shows "applied at next turn" hint.

---

## 6. Phased implementation

### Phase 0 — Scaffolding (1 day)

- Initialize Bun workspaces (`server`, `worker`, `client`).
- Install all dependencies (verified versions exist).
- Set up `bin/start.sh` with the three-process supervisor.
- Wire empty REST endpoints, empty React tabs.
- `pnpm` / `bun install` succeeds; `bun run start` brings up empty UI on `:7890`.

### Phase 1 — Minimal voice end-to-end with one fixed session (2 days)

- Port `PiSocket` from mockup into `worker/src/pi-bridge.ts`. Drop the dual-protocol logic (we know the protocol now). Drop event-shape normalization (only one shape exists).
- Port `SpokenTagParser`, `SpeechChunker`, `cleanForSpeech`, `toolStatusMessage`.
- Worker reads `socketPath` from `ctx.job.metadata`; otherwise from a CLI flag for dev.
- Server stub that lets you POST a hard-coded socketPath to `/api/sessions/select`.
- Client: a single "Connect" button that creates the dispatch and joins the room.
- Use Deepgram + Cartesia (assuming keys). Fallback to OpenAI Whisper + ElevenLabs if needed.

**Exit criteria**: speak, hear a `<spoken>` reply, see the same conversation in tmux. Same as the mockup, just on the new architecture.

### Phase 2 — Session enumeration + picker UI + folder default (2 days)

- **Pre-req**: extend rpc-socket to expose `state.cwd: process.cwd()` (one line in the getState handler). Update extension README.
- Build the poller (filesystem watch optional; polling is fine).
- Build `SessionsTab` UI with rows; show cwd column prominently.
- Wire `/api/sessions/select` end-to-end.
- Stale-socket cleanup.
- SSE for live updates.
- Folder-matching logic on startup: realpath compare `defaultFolder` against each session's `cwd`.
- "Spawn Pi in default folder" path: `tmux new-window -c <folder> 'pi …'`, diff sockets before/after to identify the new one, wait for first `state.cwd` reply.

**Exit criteria**: with `defaultFolder=/Users/lukas/dev/foo` set, opening the UI either pre-highlights the matching session (if running) or spawns one; opening with no default behaves like before.

### Phase 3 — wterm integration + tmux switching (1 day)

- Drop the supervisor's wterm files into `server/src/term/`.
- Build the `TerminalTab` host: 100% height between tab bar and extra-keys row.
- `tmux switch-client` on session-select.
- "Pin terminal" toggle in UI (suppresses follow).

**Exit criteria**: terminal tab works on desktop and Android Chrome. Switching voice target moves the terminal too. Pinning works.

### Phase 4 — Voice prompt editor (0.5 day)

- Read/write `AGENTS.voice.md`.
- `appendSystemPrompt` on save.
- "Reset to default" writes the canonical body.
- `clearSystemPrompt` on disconnect.

**Exit criteria**: edit prompt → next agent turn behaves differently → editor refreshes across browser tabs.

### Phase 5 — Earcons (1 day)

- Render three short PCM clips (Audacity by hand or an `npm`-installable beep generator).
- Worker `prewarm` loads them.
- Trigger plumbing in `llmNode`.
- Verify they don't cause AEC false-trigger by checking VAD doesn't fire while playing.

**Exit criteria**: three distinct tones at the right moments, do not echo back through the mic.

### Phase 6 — Settings + config persistence (1 day)

- Config file load/save.
- Settings tab UI.
- All knobs route to live config (some require worker restart — call that out in UI).

**Exit criteria**: changing tmux socket name lets the app talk to a different tmux server.

### Phase 7 — Tailscale + PWA polish (0.5 day)

- Bind 0.0.0.0; document the Tailscale URL.
- Add `manifest.json`, icons, simple service worker.
- Verify PWA install on Android Chrome.
- Verify desktop install on Chrome/Edge.

**Exit criteria**: install to home screen on Android, opens fullscreen, can connect voice on the same Wi-Fi or remote via Tailscale.

### Phase 8 — Android wrapper (1–2 evenings)

- Android Studio project, single Activity, WebView, foreground service, manifest, wake lock.
- Sideload to phone, test screen-off behaviour with AirPods.

**Exit criteria**: phone in pocket, screen off, voice works for at least a 5-minute conversation.

**Total estimate**: 7–9 days of focused work for phases 0–7. Phase 8 is on top.

---

## 7. Risks and unknowns

| Risk | Mitigation |
|---|---|
| LiveKit data-channel API for publishing pre-rendered PCM may need an `audio_play` source we haven't proven. | Start with the simple path: enqueue PCM bytes into the same controller stream the TTS uses. If the controller only accepts strings, publish a small `LocalAudioTrack` from the worker. |
| `tmux switch-client` without `-c` switches the most recent client — could be the wrong one if multiple browser tabs are open. | Detect this case and disable follow if more than one wterm WebSocket is alive; or track client_pid. |
| `appendSystemPrompt` only takes effect on the *next* turn (the extension uses `before_agent_start`). | Document this in the UI. If a user edits the prompt mid-turn and expects instant effect, they can `abort` and resend. |
| iOS Safari PWA cannot run in the background. | We acknowledge this. The Android wrapper is the answer for pocket use. iPhone users would need either CallKit/SIP or screen-on operation. |
| LiveKit dev mode plaintext on Tailnet. | OK on Tailnet (encrypted). For wider exposure, document the upgrade to TLS later. |
| Worker prewarm is shared across jobs; if one socket disconnects, prewarm-cached state could leak across jobs. | Move per-socket state to job-local; prewarm only loads VAD. The mockup currently caches `piSocket` in `proc.userData` — drop that. |
| Stale `appendedSystemPrompt` if we crash before `clearSystemPrompt`. | Idempotent: next run sets it again. Worth a "clear voice prompt" button in the prompt tab anyway. |
| Multiple browser tabs racing on `POST /api/sessions/select`. | Server serializes selects in a single in-process queue. Last-write-wins. SSE lets the loser see the new state. |
| wterm package is single-pane. | We don't need multi-pane — tmux already gives multi-pane, and one wterm view of one tmux client is sufficient. |
| Detecting tmux pane death (Pi exits in TUI). | rpc-socket file disappears; poller catches it within 2 s. |
| Browser AEC quality on cheap speakers. | Document headphones-or-PTT for noisy speakerphone use. Add a future PTT toggle. |

---

## 8. Success criteria

- A 5-minute spoken conversation with Pi works end-to-end on desktop browser.
- The same conversation works in the same tmux session typed by hand, interleaved with voice, with no spoken responses to typed prompts.
- Switching between three live Pi sessions works in under 2 s with no manual tmux commands.
- The voice prompt is editable from the phone and survives restarts.
- Earcons fire at all three transitions and do not cause false barge-ins.
- Tailscale access from an Android phone, screen on, works for a full conversation.
- (Phase 8) The Android wrapper supports phone-in-pocket usage with screen off for at least 5 minutes continuously.

---

## 9. Operational notes

- `bin/start.sh` runs in the foreground; Ctrl-C tears down livekit-server, server, worker. Pi sessions in `tmux -L mysystem` are *not* touched.
- Logs: each subprocess writes to `~/.local/state/voice-agent-bridge/logs/{server,worker,livekit}.log` with daily rotation. UI's Settings tab links to "Open log directory".
- Health: `GET /api/health` returns `{server, livekit, worker, tmux, pi}` with timestamps. Surfaced in UI footer.
- Updating the rpc-socket extension: per the user's note, a running Pi must `/reload` or restart to pick up extension changes. We don't fight this — the UI shows the rpc-socket protocol version (read from a constant) and warns if it's older than expected.

---

## 10. What we are explicitly *not* doing in v1

- Multi-user / multi-browser concurrent voice sessions.
- Authentication beyond a shared token.
- Full TLS termination (Tailscale handles transport encryption).
- iOS native wrapper.
- Custom multi-pane terminal split (use tmux).
- A separate filter LLM for summarization (`<spoken>` tags + the cleaned-text fallback are sufficient; revisit if quality is poor).
- Conversation memory beyond what Pi already maintains.
- Claude Code / Codex agent adapters — Pi only for v1. The Bridge interface is not abstracted; we refactor only when we add a second agent.
