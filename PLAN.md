# pi-voice-control — Plan

A Pi extension for full bidirectional voice interaction: speak to Pi, hear Pi speak back, with smart output translation and interruption support.

## Goals

1. **Speech input** — hold-to-talk or continuous listening with VAD, streaming transcription
2. **Speech output** — agent responses read aloud with natural speech
3. **Smart output translation** — markdown, code blocks, tables, and technical output converted to speakable summaries
4. **Interruption** — user can speak mid-response to stop/redirect the agent

## Reference Projects Studied

| Project | Key Insight Taken |
|---|---|
| **pi-listen** (v5.0.7, 49 stars) | Pi extension API patterns: `ctx.ui.onTerminalInput()` for hold-to-talk, `ctx.ui.setEditorText()` for injecting transcriptions, `ctx.ui.setStatus()`/`setWidget()` for UI, audio capture via spawned CLI processes (rec/ffmpeg/arecord), Deepgram WebSocket streaming, sherpa-onnx local models |
| **voice-mcp-server** (erickvs) | Interruption architecture: tick-driven state machine (IDLE→AI_SPEAKING→LISTENING→PROCESSING→EXECUTING), Silero VAD barge-in (1s sustained speech at 0.95 probability), PTT via Swift sidecar with hardware key detection, TTS stop via subprocess kill, backchannel filtering (<250ms speech ignored), hexagonal ports/adapters pattern |
| **claude-code-voice-agent** (larryhudson) | LiveKit pipeline: Silero VAD + multilingual turn detector + AssemblyAI STT + Cartesia TTS, interruption via `client.interrupt()`, system prompt instructs concise speech-friendly output, tool execution yields spoken status messages ("Reading file..."), FlushSentinel for immediate TTS processing |
| **claude-code-voice** (jeanduplessis) | LLM summarization: Gemma 3 4B summarizes tool output in ≤40 words before TTS, prompt: "Summarize the completed task for audio notification. Be concise, clear, natural for speech. Avoid technical jargon." Orpheus 3B local TTS with SNAC streaming decoder |
| **claude-code-voice-hook** (praneybehl) | Markdown stripping: sed-based regex pipeline — code blocks→"[code block]", strip inline code, unwrap bold/italic/links, remove header markers/bullets/numbered lists, collapse whitespace. Simple and effective. |

## Architecture

### Overview

A single Pi extension with two subsystems that share a state machine:

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Extension                          │
│                                                          │
│  ┌──────────┐     ┌──────────┐     ┌──────────────────┐ │
│  │ STT Input│     │  State   │     │  TTS Output      │ │
│  │          │────▶│ Machine  │────▶│                   │ │
│  │ Mic ─▶   │     │          │     │ Transform ─▶     │ │
│  │ Deepgram │     │ IDLE     │     │ Speak             │ │
│  │ /Whisper │     │ LISTENING│     │                   │ │
│  │          │     │ SPEAKING │     │                   │ │
│  └──────────┘     │ WAITING  │     └──────────────────┘ │
│                    └──────────┘                           │
│                                                          │
│  Events: before_agent_start, tool_result, tool_call      │
│  Commands: /voice, /voice-settings                       │
│  Shortcuts: hold-to-talk (SPACE), toggle (Ctrl+Shift+V)  │
└─────────────────────────────────────────────────────────┘
```

### State Machine

```
IDLE ──(hold-to-talk / VAD trigger)──▶ LISTENING
LISTENING ──(silence / key release)──▶ PROCESSING
PROCESSING ──(transcription done)──▶ IDLE (text injected into editor)
IDLE ──(agent responds)──▶ SPEAKING
SPEAKING ──(TTS done)──▶ IDLE
SPEAKING ──(user speaks / barge-in)──▶ LISTENING (TTS killed, captures speech)
```

### Design Decisions

**Single extension, not MCP server.** Unlike voice-mcp-server which uses a three-tier architecture (Node.js→Python MCP→Python daemon), we build everything as a Pi extension. Reasons:
- Direct access to Pi lifecycle events (`tool_call`, `tool_result`, `before_agent_start`) for intercepting output
- Direct access to `ctx.ui.setEditorText()` for injecting transcriptions
- No serialization overhead or process management complexity
- Pi extensions already support long-lived state (proven by our web tools extension)

**Audio capture via CLI subprocess** (like pi-listen). Spawns `rec` (SoX), `ffmpeg`, or `arecord` for mic input. Avoids native audio library dependencies (portaudio/node-audio) which are fragile across platforms.

**Audio playback via CLI subprocess** (like voice-mcp-server). Uses `afplay` (macOS), `aplay` (Linux) for TTS output. Playback process can be killed instantly for interruption.

**Pluggable STT/TTS adapters** (like voice-mcp-server's ports/adapters pattern). Clean interfaces so providers can be swapped without changing core logic.

## Components

### 1. Audio Capture (`audio/capture.ts`)

Adapted from pi-listen's approach. Spawns a CLI process for mic recording.

```typescript
interface AudioCapture {
  start(): void;                           // Start recording, emit PCM chunks
  stop(): Promise<Buffer>;                 // Stop recording, return accumulated audio
  onChunk(callback: (chunk: Buffer) => void): void;  // Stream chunks for real-time STT
  isRecording(): boolean;
}
```

**Process selection** (try in order):
1. `rec` (SoX) — `rec -q --buffer 4096 -c 1 -b 16 -e signed-integer -t raw - rate 16000`
2. `ffmpeg` — platform-specific input device
3. `arecord` — Linux ALSA fallback

Output: raw 16-bit signed LE PCM at 16kHz mono, streamed via subprocess stdout.

### 2. Audio Playback (`audio/playback.ts`)

Plays audio files/streams via CLI processes. Key feature: can be killed instantly for interruption.

```typescript
interface AudioPlayback {
  play(audioPath: string): Promise<void>;  // Play a file, resolves when done
  playStream(stream: ReadableStream): Promise<void>;  // Play streaming audio
  stop(): void;                            // Kill playback immediately
  isPlaying(): boolean;
}
```

**Implementation:**
- macOS: `afplay <file>` (WAV/MP3/AAC)
- Linux: `aplay <file>` (WAV) or `ffplay -nodisp -autoexit <file>`
- Stop: `process.kill()` on the playback subprocess

### 3. STT Adapters (`stt/`)

#### Deepgram Streaming (`stt/deepgram.ts`)
- WebSocket to `wss://api.deepgram.com/v1/listen`
- Params: `encoding=linear16, sample_rate=16000, channels=1, interim_results=true, smart_format=true, endpointing=200, utterance_end_ms=1000`
- Streams PCM chunks in real-time, receives interim + final transcripts
- Env var: `DEEPGRAM_API_KEY`

#### Local Whisper (`stt/whisper.ts`)
- Batch mode: accumulate audio, transcribe on stop
- Uses `sherpa-onnx-node` (optional dependency) for in-process ONNX inference
- Or calls an external OpenAI-compatible STT endpoint (`/v1/audio/transcriptions`)
- Env var: `WHISPER_ENDPOINT` (optional, for external server)

#### Interface

```typescript
interface STTAdapter {
  readonly id: string;
  readonly streaming: boolean;             // true for Deepgram, false for Whisper
  isAvailable(): boolean;
  startSession(): STTSession;
}

interface STTSession {
  feedAudio(chunk: Buffer): void;          // Feed PCM chunks (streaming mode)
  onInterim(cb: (text: string) => void): void;   // Interim results (streaming)
  onFinal(cb: (text: string) => void): void;     // Final results
  finish(): Promise<string>;               // Stop and get final transcript
  abort(): void;                           // Cancel without result
}
```

### 4. TTS Adapters (`tts/`)

#### Cartesia (`tts/cartesia.ts`)
- REST/WebSocket API, <100ms latency
- Streaming: receives audio chunks as they're generated
- Saves chunks to temp file, plays via `afplay`
- Env var: `CARTESIA_API_KEY`

#### ElevenLabs (`tts/elevenlabs.ts`)
- REST API with streaming response
- Env var: `ELEVENLABS_API_KEY`

#### OpenAI TTS (`tts/openai.ts`)
- `/v1/audio/speech` endpoint
- Streaming response
- Env var: `OPENAI_API_KEY` (shared with other uses)

#### macOS Say (`tts/say.ts`)
- Zero-dependency, zero-latency fallback
- `say -v <voice> <text>` as subprocess
- No streaming (speaks full text at once)
- Kill subprocess for instant stop

#### Kokoro Local (`tts/kokoro.ts`)
- Local ML model via Python subprocess
- Env var: none (auto-downloads model)

#### Interface

```typescript
interface TTSAdapter {
  readonly id: string;
  readonly streaming: boolean;
  isAvailable(): boolean;
  speak(text: string): TTSPlayback;
}

interface TTSPlayback {
  onStart(cb: () => void): void;           // Audio started playing
  onDone(cb: () => void): void;            // Finished speaking
  stop(): void;                            // Kill immediately (for interruption)
  hasStartedAudio(): boolean;              // Has audible output begun?
}
```

### 5. Output Transformer (`transform/`)

This is the key unsolved problem. Three strategies, applied in combination:

#### Strategy A: System Prompt Injection (`transform/prompt.ts`)

Inject via `before_agent_start` event:

```
When voice mode is active, end each response with a <spoken> tag containing
a concise, natural spoken summary (1-3 sentences) of what you did.
Do not include code, markdown formatting, file paths, or technical details
in the spoken summary. Example:
<spoken>I've updated the login function to handle the edge case you mentioned.
The test passes now.</spoken>
```

This is the smartest approach — the agent produces both a full technical response (visible in terminal) AND a spoken summary. No post-processing needed. The extension extracts the `<spoken>` tag content and sends it to TTS.

**Pros:** Highest quality summaries, context-aware, zero latency overhead.
**Cons:** Uses some extra output tokens (~20-50 per response). The model might not always comply.

#### Strategy B: Regex Stripping (`transform/strip.ts`)

Fallback when Strategy A's `<spoken>` tag is not present. Adapted from praneybehl:

1. Replace code blocks (```) with "[code block]"
2. Remove inline code
3. Unwrap bold/italic/links to plain text
4. Remove header markers, bullet points, numbered lists
5. Collapse whitespace
6. Truncate to configurable max length (default 500 chars)

**Pros:** Zero latency, deterministic, no API calls.
**Cons:** Robotic, reads things that shouldn't be spoken ("I'll create the file at src/utils/helper.ts").

#### Strategy C: LLM Summarization (`transform/summarize.ts`)

For high-quality summaries without relying on the agent's cooperation. Calls a fast/cheap model:

```
System: Summarize this agent response as a brief spoken notification (under 40 words).
Be natural and conversational. Focus on what was accomplished.
Do not mention file paths, function names, or code.
User: [agent response text, truncated to 2000 chars]
```

Uses the cheapest available model: Haiku, Gemini Flash, or a local model.

**Pros:** High quality, works with any agent output.
**Cons:** Adds 200-500ms latency, costs tokens.

#### Recommended Default

Strategy A (system prompt injection) as primary, with Strategy B (regex stripping) as fallback when no `<spoken>` tag is found. Strategy C available as a config option for users who want higher quality without the `<spoken>` tag approach.

### 6. Interruption Engine (`engine/interruption.ts`)

Adapted from voice-mcp-server's approach, simplified for a Pi extension context.

**During SPEAKING state:**
1. Audio capture stays active (mic is live while TTS plays)
2. Every audio chunk is fed to a lightweight VAD check
3. If sustained speech detected (configurable threshold, default 800ms), barge-in fires:
   - Kill TTS playback subprocess immediately
   - Transition to LISTENING state
   - Preserved audio buffer is fed to STT
   - Transcription is injected into editor

**VAD options:**
- **Silero VAD** via ONNX runtime (best accuracy, requires sherpa-onnx-node)
- **Energy-based VAD** (simple RMS threshold, no dependencies, less accurate)
- **PTT mode** (hold key to interrupt — simplest, most reliable)

**Echo cancellation:**
None — like voice-mcp-server, require headphones for VAD-based interruption. PTT mode works without headphones.

### 7. Hold-to-Talk (`input/hold-to-talk.ts`)

Adapted from pi-listen. Uses `ctx.ui.onTerminalInput()` to intercept keystrokes.

**Two terminal modes** (like pi-listen):
- Kitty protocol terminals (true key release events): Hold SPACE, immediate warmup, release stops
- Non-Kitty terminals: Detect rapid repeated presses as a hold, gap = release

**Thresholds:**
- Tap (<300ms): types a space normally
- Short hold (300ms-1200ms): "hold longer" hint
- Long hold (>=1200ms): recording starts
- Typing cooldown: 400ms after any non-space key, holds ignored

**Warmup phase:** Start STT session during warmup so no words are lost when recording activates.

**Tail recording:** Continue recording 1500ms after release to catch trailing words.

### 8. Extension Entry Point (`index.ts`)

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  // State
  const state = createStateMachine();
  const config = loadConfig();
  const stt = resolveSTTAdapter(config);
  const tts = resolveTTSAdapter(config);
  const transformer = createTransformer(config);

  // Hold-to-talk via terminal input interception
  pi.on("session_start", (event) => {
    const ctx = event.context;
    ctx.ui.onTerminalInput((input) => {
      return handleHoldToTalk(input, state, stt, ctx);
    });
  });

  // Inject spoken summary instruction into system prompt
  pi.on("before_agent_start", (event) => {
    if (config.voiceEnabled) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + SPOKEN_SUMMARY_PROMPT,
      };
    }
  });

  // Intercept agent responses for TTS
  pi.on("tool_result", (event) => {
    if (config.voiceEnabled && state.current !== "SPEAKING") {
      const spokenText = transformer.extract(event);
      if (spokenText) {
        state.transition("SPEAKING");
        const playback = tts.speak(spokenText);
        // Set up interruption monitoring during playback
        playback.onDone(() => state.transition("IDLE"));
      }
    }
  });

  // Slash commands
  pi.registerCommand("voice", {
    description: "Voice control (on/off/settings)",
    handler: async (args, ctx) => { /* ... */ },
  });

  pi.registerCommand("voice-settings", {
    description: "Configure voice providers and settings",
    handler: async (args, ctx) => { /* ... */ },
  });

  // Toggle shortcut
  pi.registerShortcut("ctrl+shift+v", {
    handler: () => { config.voiceEnabled = !config.voiceEnabled; },
  });
}
```

## File Structure

```
pi-voice-control/
├── package.json
├── README.md
├── PLAN.md                          # This file
├── extensions/
│   └── voice/
│       ├── index.ts                 # Extension entry point
│       ├── package.json             # Dependencies
│       ├── state.ts                 # State machine (IDLE/LISTENING/SPEAKING/PROCESSING)
│       ├── config.ts                # Configuration management
│       ├── audio/
│       │   ├── capture.ts           # Mic recording via CLI subprocess
│       │   └── playback.ts          # Audio playback via CLI subprocess
│       ├── stt/
│       │   ├── types.ts             # STTAdapter, STTSession interfaces
│       │   ├── deepgram.ts          # Deepgram streaming WebSocket
│       │   ├── whisper.ts           # Local Whisper via sherpa-onnx or endpoint
│       │   └── resolve.ts           # Pick best available STT adapter
│       ├── tts/
│       │   ├── types.ts             # TTSAdapter, TTSPlayback interfaces
│       │   ├── cartesia.ts          # Cartesia streaming TTS
│       │   ├── elevenlabs.ts        # ElevenLabs streaming TTS
│       │   ├── openai.ts            # OpenAI TTS API
│       │   ├── say.ts               # macOS `say` fallback
│       │   ├── kokoro.ts            # Local Kokoro ML model
│       │   └── resolve.ts           # Pick best available TTS adapter
│       ├── transform/
│       │   ├── prompt.ts            # <spoken> tag system prompt injection
│       │   ├── strip.ts             # Regex markdown stripping
│       │   ├── summarize.ts         # LLM summarization (optional)
│       │   └── index.ts             # Transformer pipeline
│       ├── input/
│       │   ├── hold-to-talk.ts      # SPACE hold detection via onTerminalInput
│       │   └── vad.ts               # Voice activity detection (Silero/energy/PTT)
│       └── engine/
│           └── interruption.ts      # Barge-in detection during TTS playback
```

## Dependencies

```json
{
  "dependencies": {},
  "optionalDependencies": {
    "sherpa-onnx-node": "^1.12.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  }
}
```

Minimal npm dependencies — like pi-listen, use only Node.js built-ins + native WebSocket/fetch. External CLI tools (rec/ffmpeg/afplay) for audio I/O. Optional `sherpa-onnx-node` for local STT/VAD.

## Env Vars

| Var | Provider | Required? |
|---|---|---|
| `DEEPGRAM_API_KEY` | Deepgram STT (streaming) | For cloud STT |
| `CARTESIA_API_KEY` | Cartesia TTS | For cloud TTS |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS | Alternative cloud TTS |
| `OPENAI_API_KEY` | OpenAI TTS / Whisper API | Alternative cloud STT/TTS |
| `WHISPER_ENDPOINT` | External Whisper server | For self-hosted STT |

No env vars required if using local-only setup (sherpa-onnx for STT + macOS `say` for TTS).

## Configuration

Stored in `~/.pi/agent/settings.json` under `"voice"` key (like pi-listen):

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

## Implementation Phases

### Phase 1: Core Infrastructure
- State machine, config, audio capture/playback
- Hold-to-talk with SPACE (adapted from pi-listen)
- Deepgram streaming STT
- macOS `say` TTS (zero-dependency starting point)
- Basic regex stripping for output

### Phase 2: Smart Output
- `<spoken>` tag system prompt injection
- Transformer pipeline (extract tag → fallback to strip)
- Hook into `tool_result` events for automatic TTS

### Phase 3: Better TTS
- Cartesia adapter (streaming, low latency)
- ElevenLabs adapter
- OpenAI TTS adapter
- Adapter auto-selection based on available API keys

### Phase 4: Interruption
- Energy-based VAD (simple, no dependencies)
- PTT interruption mode (hold key to interrupt)
- Silero VAD via sherpa-onnx (optional, best accuracy)
- Barge-in state transitions

### Phase 5: Polish
- Local Whisper STT adapter
- Kokoro local TTS adapter
- Settings panel TUI
- Voice selection per TTS provider
- Audio level visualization widget

## Open Questions

1. **Which Pi event to hook for TTS output?** `tool_result` fires per-tool. We probably want to speak after the agent's full response, not after each tool call. Need to investigate if there's an "agent turn complete" event, or if we should use `tool_result` and debounce.

2. **Echo cancellation without headphones.** Voice-mcp-server punts on this (requires headphones). Could we use a simple gate (mute mic during TTS playback) as a compromise? This prevents interruption but avoids false triggers.

3. **Streaming TTS + interruption.** For streaming TTS (Cartesia/ElevenLabs), we need to start playing audio chunks while more are still arriving. The playback process approach (write to temp file → afplay) doesn't support this well. May need a different playback mechanism for streaming (e.g., pipe audio to ffplay stdin, or use a small streaming server).

4. **Token cost of `<spoken>` tags.** The system prompt injection adds ~100 tokens of instruction and ~20-50 tokens per response for the spoken summary. For frequent tool calls this adds up. May want to only request spoken summaries for the final response in a turn, not intermediate tool calls.
