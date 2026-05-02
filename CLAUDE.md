# Voice Agent Bridge

A standalone voice conversation server — speak to your coding agents (Pi, Claude Code, Codex) like ChatGPT Voice Mode. API-first: any client (phone, desktop, CLI) can connect.

## What This Is

An API server that sits between you and your coding agents:

```
You (voice) ←→ Voice API Server ←→ Agents (Pi/Claude/Codex)
                     ↕
               Filter LLM (summarizes agent output for speech)
```

1. You speak → STT transcribes → sends text to agent
2. Agent works (may take seconds for tool calls) → response comes back
3. Filter LLM converts technical response to natural speech → TTS speaks it
4. You can interrupt at any time (kills TTS, captures your speech, redirects agent)

## API

The server exposes REST, WebSocket, and SSE endpoints. No built-in UI — clients are separate.

- **`/ws/audio`** — bidirectional audio stream (PCM in, TTS audio + JSON events out)
- **`/ws/text`** — text-only mode
- **`POST /sessions`** — start a session with an agent
- **`POST /sessions/:id/converse`** — send text/audio, get response
- **`GET /sessions/:id/events`** — SSE event stream (status, transcript, tool use)
- **`GET /agents`** — list available agents

## Agent Adapters

| Agent | Interface | Streaming | Interruption | Key Feature |
|---|---|---|---|---|
| **Pi** | RPC mode (`pi --mode rpc`, JSONL stdin/stdout) | Yes (text_delta) | `steer` command | Redirect agent mid-response |
| **Claude Code** | Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Yes (partial messages) | `interrupt()` | Tool call events |
| **Codex** | SDK (`@openai/codex-sdk`) | Yes (runStreamed) | Thread management | Resume threads |
| **Generic CLI** | Print mode (`<agent> -p "prompt"`) | No | Kill process | Works with anything |

## Voice Pipeline

### STT (Speech-to-Text)

| Provider | Latency | Streaming | Cost/min |
|---|---|---|---|
| Deepgram Flux | <300ms end-of-turn | WebSocket | $0.0077 |
| Groq Whisper | ~100ms processing | Batch (228x realtime) | $0.0007 |
| sherpa-onnx | ~50ms/chunk | Local streaming | Free |
| OpenAI Whisper | ~940ms | Batch | $0.006 |

### TTS (Text-to-Speech)

| Provider | TTFB | Quality | Cost |
|---|---|---|---|
| Cartesia Sonic-3 | 90ms | Good | ~$0.01/min |
| ElevenLabs Flash | 370ms | Best | $0.17-0.36/min |
| Orpheus (local) | 100-200ms | Good | Free |
| macOS `say` | 700ms | Robotic | Free |

### Filter LLM (Summarization)

Converts agent markdown/code output to natural spoken summaries.

| Provider | Latency | Cost/call |
|---|---|---|
| Groq Llama 8B | ~160ms | $0.0001 |
| Gemini Flash-Lite | ~300ms | $0.0002 |
| Haiku 4.5 | ~400ms | $0.002 |

### Total Pipeline Cost: ~$0.018/min (vs Vapi $0.08, OpenAI Realtime $0.30)

## Tech Stack

- **Server**: TypeScript on Bun (agent SDKs are all npm packages)
- **Audio I/O**: ffmpeg/ffplay subprocesses (local), WebSocket + AudioWorklet (phone)
- **VAD**: Silero VAD via sherpa-onnx-node
- **Phone client**: Single HTML page served by the server, PWA-installable

## Project Structure

```
voice-agent-bridge/
├── src/
│   ├── server.ts            # Bun HTTP/WebSocket server
│   ├── session.ts           # Session management
│   ├── api/                 # REST, WebSocket, SSE handlers
│   ├── agents/              # Agent bridge adapters (Pi, Claude, Codex, generic)
│   ├── voice/               # Pipeline orchestration, state machine, interruption
│   ├── stt/                 # STT adapters (Deepgram, Groq, sherpa, OpenAI)
│   ├── tts/                 # TTS adapters (Cartesia, ElevenLabs, Orpheus, say)
│   ├── filter/              # Response summarization (Groq, Haiku, regex)
│   ├── audio/               # Local mic/speaker via subprocesses
│   ├── transport/           # Audio transport (local, WebSocket)
│   └── vad/                 # Silero VAD, energy VAD
├── client/                  # Phone web client (single HTML page + AudioWorklet)
└── scratch/                 # Research artifacts
```

## Env Vars

| Var | For |
|---|---|
| `DEEPGRAM_API_KEY` | Primary STT |
| `GROQ_API_KEY` | Fast STT + Filter LLM |
| `CARTESIA_API_KEY` | Lowest-latency TTS |
| `ELEVENLABS_API_KEY` | Highest-quality TTS |
| `OPENAI_API_KEY` | Fallback STT/TTS |
| `ANTHROPIC_API_KEY` | Claude agent + Haiku filter |

Minimum: `GROQ_API_KEY` + macOS `say`. Fully local: sherpa-onnx + Orpheus + Gemma (no API keys, higher latency).

## Implementation Phases

1. **Core** — Bun server, Pi agent adapter, Deepgram STT, macOS `say`, regex strip, local audio
2. **Better voice** — Cartesia/ElevenLabs TTS, Groq filter LLM, VAD interruption
3. **More agents** — Claude Code + Codex adapters, generic CLI, auto-detection
4. **Phone** — Web client with AudioWorklet, WebSocket transport, PWA
5. **Polish** — Local STT/TTS, conversation memory, config UI, concurrent sessions

## Research Artifacts

Detailed findings from hands-on testing in `scratch/`:
- `realtime-voice-research.md` — Full comparison of voice APIs, STT/TTS providers, latency budgets
- `agent-interface-research.md` — Claude Code, Pi, Codex CLI and SDK interfaces
- `web-client-research.md` — Browser audio, WebSocket vs WebRTC, echo cancellation
- `audio-findings.md` — macOS audio capture/playback tools (tested)
- `stt-findings.md` — Deepgram, sherpa-onnx, OpenAI Whisper (tested)
- `tts-findings.md` — ElevenLabs, OpenAI, Cartesia, Kokoro, macOS say (tested)
- `transform-findings.md` — Regex stripping, spoken tag extraction, Pi events (tested)
