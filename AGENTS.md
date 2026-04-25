# pi-voice-control

A Pi coding agent extension for full bidirectional voice interaction — speak to Pi, hear Pi speak back, with smart output translation and interruption support.

## Project Structure

```
pi-voice-control/
├── AGENTS.md                        # This file
├── PLAN.md                          # Detailed architecture plan with research findings
├── extensions/
│   └── voice/
│       ├── index.ts                 # Extension entry point — registers events, commands, shortcuts
│       ├── package.json             # Dependencies (minimal — mostly peer/optional)
│       ├── state.ts                 # State machine (IDLE / LISTENING / SPEAKING / PROCESSING)
│       ├── config.ts                # Configuration management (~/.pi/agent/settings.json)
│       ├── audio/
│       │   ├── capture.ts           # Mic recording via CLI subprocess (rec/ffmpeg/arecord)
│       │   └── playback.ts          # Audio playback via CLI subprocess (afplay/aplay)
│       ├── stt/                     # Speech-to-text adapters
│       │   ├── types.ts             # STTAdapter / STTSession interfaces
│       │   ├── deepgram.ts          # Deepgram Nova streaming via WebSocket
│       │   ├── whisper.ts           # Local Whisper via sherpa-onnx or external endpoint
│       │   └── resolve.ts           # Auto-select best available STT
│       ├── tts/                     # Text-to-speech adapters
│       │   ├── types.ts             # TTSAdapter / TTSPlayback interfaces
│       │   ├── cartesia.ts          # Cartesia Sonic streaming (<100ms latency)
│       │   ├── elevenlabs.ts        # ElevenLabs streaming
│       │   ├── openai.ts            # OpenAI TTS API
│       │   ├── say.ts               # macOS `say` (zero-dependency fallback)
│       │   ├── kokoro.ts            # Kokoro local ML model
│       │   └── resolve.ts           # Auto-select best available TTS
│       ├── transform/               # Output-to-speech translation
│       │   ├── prompt.ts            # <spoken> tag system prompt injection
│       │   ├── strip.ts             # Regex markdown/code stripping
│       │   ├── summarize.ts         # LLM summarization (optional)
│       │   └── index.ts             # Transformer pipeline (tag → strip → summarize)
│       ├── input/
│       │   ├── hold-to-talk.ts      # SPACE hold detection via ctx.ui.onTerminalInput
│       │   └── vad.ts               # Voice activity detection (Silero / energy / PTT)
│       └── engine/
│           └── interruption.ts      # Barge-in detection during TTS playback
```

## How It Works

### Speech Input (STT)

Hold SPACE for 1.2 seconds to start recording. Audio is captured via a spawned CLI process (`rec` from SoX, `ffmpeg`, or `arecord`) and streamed to the STT adapter. Deepgram provides real-time streaming transcription with interim results visible in the editor. On release, a 1.5s tail recording captures trailing words, then the final transcript is injected into Pi's editor via `ctx.ui.setEditorText()`.

A warmup phase pre-opens the STT session during the hold threshold so no words are lost.

### Speech Output (TTS)

When the agent responds, the output transformer extracts speakable content and sends it to the TTS adapter. Three strategies (in priority order):

1. **`<spoken>` tag** — system prompt asks the agent to include a natural spoken summary in a `<spoken>` tag. Best quality, zero post-processing latency.
2. **Regex stripping** — fallback that strips markdown formatting, replaces code blocks with "[code block]", removes headers/bullets/links.
3. **LLM summarization** — optional, calls a cheap model to produce a 40-word spoken summary.

Audio is played via `afplay` (macOS) or `aplay` (Linux) as a subprocess, which can be killed instantly for interruption.

### Interruption

During TTS playback, the mic stays live. VAD (voice activity detection) monitors for sustained user speech. When detected (default 800ms threshold), the TTS subprocess is killed immediately, the captured speech is transcribed, and the transcript is fed back into the editor.

Three interruption modes:
- **PTT** (push-to-talk) — hold a key to interrupt. Works without headphones.
- **Silero VAD** — ML-based speech detection. Requires headphones (no echo cancellation).
- **Energy VAD** — simple RMS threshold. Less accurate, no dependencies.

## Pi Extension API Usage

| API | Purpose |
|---|---|
| `ctx.ui.onTerminalInput(cb)` | Intercept SPACE holds for hold-to-talk |
| `ctx.ui.setEditorText(text)` | Inject transcriptions into the editor |
| `ctx.ui.getEditorText()` | Snapshot editor text before recording |
| `ctx.ui.setStatus(id, ...)` | Status bar: MIC, REC, STT processing |
| `ctx.ui.setWidget(id, ...)` | Recording waveform / warmup progress widget |
| `pi.on("before_agent_start", ...)` | Inject `<spoken>` tag system prompt |
| `pi.on("tool_result", ...)` | Intercept agent output for TTS |
| `pi.registerCommand("voice", ...)` | `/voice on\|off\|settings` |
| `pi.registerShortcut(...)` | Ctrl+Shift+V toggle |

## STT/TTS Adapter Interfaces

All adapters follow the same pattern — a pluggable interface with auto-selection based on available API keys / system tools.

### STT

```typescript
interface STTAdapter {
  readonly id: string;
  readonly streaming: boolean;
  isAvailable(): boolean;
  startSession(): STTSession;
}
```

| Adapter | Type | Env Var | Streaming |
|---|---|---|---|
| Deepgram Nova | Cloud | `DEEPGRAM_API_KEY` | Yes |
| Whisper (sherpa-onnx) | Local | — | No (batch) |
| Whisper (external) | Self-hosted | `WHISPER_ENDPOINT` | No (batch) |

### TTS

```typescript
interface TTSAdapter {
  readonly id: string;
  readonly streaming: boolean;
  isAvailable(): boolean;
  speak(text: string): TTSPlayback;
}
```

| Adapter | Type | Env Var | Latency |
|---|---|---|---|
| Cartesia Sonic | Cloud | `CARTESIA_API_KEY` | <100ms |
| ElevenLabs | Cloud | `ELEVENLABS_API_KEY` | ~75ms |
| OpenAI TTS | Cloud | `OPENAI_API_KEY` | ~200ms |
| macOS `say` | Local | — | Instant |
| Kokoro | Local ML | — | ~200ms |

## Configuration

Stored in `~/.pi/agent/settings.json` under `"voice"`:

```json
{
  "voice": {
    "enabled": true,
    "stt": "deepgram",
    "tts": "cartesia",
    "language": "en",
    "holdToTalkKey": "space",
    "toggleShortcut": "ctrl+shift+v",
    "interruptionMode": "ptt",
    "interruptionThresholdMs": 800,
    "outputTransform": "spoken-tag",
    "ttsVoice": "default",
    "maxSpokenChars": 500
  }
}
```

## System Requirements

- **Audio capture**: One of `sox` (rec), `ffmpeg`, or `arecord` must be on PATH
- **Audio playback**: `afplay` (macOS, built-in) or `aplay`/`ffplay` (Linux)
- **Headphones**: Required for Silero VAD interruption mode (no echo cancellation)
- **Optional**: `sherpa-onnx-node` for local STT, Python + kokoro for local TTS

## Implementation Phases

1. **Core** — state machine, audio capture/playback, hold-to-talk, Deepgram STT, macOS `say` TTS, regex stripping
2. **Smart output** — `<spoken>` tag prompt injection, transformer pipeline, `tool_result` hooks
3. **Better TTS** — Cartesia/ElevenLabs/OpenAI adapters, auto-selection
4. **Interruption** — energy VAD, PTT mode, Silero VAD, barge-in state transitions
5. **Polish** — local Whisper STT, Kokoro TTS, settings panel TUI, voice selection

## Key Design Decisions

- **Single Pi extension, not MCP server** — direct access to Pi lifecycle events, editor API, and UI widgets. No process management overhead.
- **Audio I/O via CLI subprocesses** — avoids fragile native audio library dependencies (portaudio). Playback subprocess can be killed instantly for interruption.
- **Pluggable adapters** — clean interfaces for STT/TTS so providers can be swapped without changing core logic.
- **`<spoken>` tag approach for output** — the agent produces both full technical output AND a spoken summary. No post-processing needed, highest quality.
- **No echo cancellation** — PTT mode (default) sidesteps the problem. VAD mode requires headphones, like voice-mcp-server.

## Reference Projects

This extension draws from the best parts of several existing projects:

| Project | What we took |
|---|---|
| [pi-listen](https://github.com/codexstar69/pi-listen) | Hold-to-talk via `onTerminalInput`, audio capture via CLI, Deepgram streaming, warmup/tail recording, editor text injection |
| [voice-mcp-server](https://github.com/erickvs/voice-mcp-server) | Interruption state machine, Silero VAD barge-in, PTT via hardware key detection, backchannel filtering, ports/adapters pattern |
| [claude-code-voice-agent](https://github.com/larryhudson/claude-code-voice-agent) | System prompt for speech-friendly output, tool status messages during execution, FlushSentinel pattern |
| [claude-code-voice](https://github.com/jeanduplessis/claude-code-voice) | LLM summarization approach (Gemma 3 4B → 40-word summary before TTS) |
| [claude-code-voice-hook](https://github.com/praneybehl/claude-code-voice-hook) | Regex markdown stripping pipeline for TTS |
