# Notes

Running observations, test results, and design decisions from prototyping.

## 2026-04-26: bare-local mockup testing

### Test Results

Tested `bun run main.ts --vad` with Pi. Both manual (ENTER) and VAD modes work. VAD correctly detects speech start/stop with ~1.5s silence threshold.

**Timings (bare-local, slowest possible stack):**
- STT (OpenAI Whisper batch): ~1-2s
- Pi thinking: ~2-6s (depends on query, includes fallback to plain output)
- TTS (macOS `say`): ~4-7s (depends on response length)
- Total round-trip: ~10-15s

**Pi stream-json parsing**: Falls back to plain output — the text_delta event format from Pi doesn't match the three shapes we're checking. Needs investigation. Not blocking since plain output works.

### Observation 1: Agent responses need speech adaptation

Raw agent output doesn't work well for speech. The weather query returned markdown with bold, links, bullet points, temperatures with degree symbols, source URLs — all terrible for TTS.

**Two approaches (not mutually exclusive):**

A. **`<spoken>` tag approach (preferred)** — Inject a system prompt telling the agent to wrap speech-friendly content in `<spoken>` tags. The agent has full context and can produce natural summaries. Zero extra latency. Multiple tags throughout a response give a live conversational feel.

System prompt to inject:
```
Voice mode is active. Wrap anything you want spoken aloud in <spoken> tags.
Use these liberally: acknowledge the user's request immediately, give status
updates during long tasks, and summarize your final answer. Keep spoken
content conversational — no code, file paths, or markdown.
```

Pi supports `--append-system-prompt` for this. Claude Code also supports it.

B. **LLM summarization (fallback)** — Use a fast/cheap model (Groq Llama 8B ~160ms) to summarize the agent's response into speech-friendly text. Works when the agent doesn't produce `<spoken>` tags. Adds ~160-400ms latency.

Both should be implemented. `<spoken>` tag as primary, LLM summarization as configurable fallback.

### Observation 2: No feedback during long agent tasks

When the agent takes 5-10+ seconds (e.g., web search, complex tool use), there's dead silence. The user doesn't know if the system is working or broken.

**Solution: streaming `<spoken>` tag extraction.** Instead of waiting for Pi's full response, stream its output and extract `<spoken>` tags as they appear in real-time. The agent can emit:

1. `<spoken>Sure, let me look that up for you.</spoken>` — immediately at the start
2. (agent does web search, reads files, etc.)
3. `<spoken>The weather in London is sunny and 21 degrees.</spoken>` — at the end

The voice server speaks each `<spoken>` tag as soon as it's complete, while the agent continues working. This gives immediate acknowledgment and a final summary — feels much more conversational.

This requires changing from "wait for full response then speak" to "stream response, extract and speak tags as they appear."

### Observation 3: No interruption support

The bare-local mockup has no way to interrupt the agent or TTS. If the agent produces a long response, you have to wait for `say` to finish.

**In scope for the full product.** Approaches:
- Kill the `say` subprocess (instant stop, tested and works)
- In VAD mode, detect speech during TTS playback → kill TTS → capture new speech → send to agent
- Pi's `steer` command can redirect the agent mid-response without killing the session
- Claude SDK has `interrupt()` method

**For bare-local mockup**, a simple improvement: listen for ENTER during TTS playback to skip/interrupt.

### Observation 4: Agent-provided speech tools

Instead of having the voice server extract `<spoken>` tags from text output, the agent could have an explicit tool for speaking. For example:

```
Tool: speak
Description: Speak a message to the user via voice. Use this to acknowledge requests,
  give status updates, and deliver final answers.
Parameters:
  message: string — what to say (conversational, no markdown)
```

This is more reliable than `<spoken>` tags in text (the agent might forget or format them wrong) and gives the voice server explicit tool call events to hook into. However, it requires the voice server to register tools with the agent, which is more complex than just appending a system prompt.

**Decision: Start with `<spoken>` tags (simpler), consider tool-based approach if tags prove unreliable.**

### Next steps for bare-local

1. Add `--append-system-prompt` with `<spoken>` tag instructions to the Pi invocation
2. Stream Pi's output and extract `<spoken>` tags in real-time (speak as they appear)
3. Add ENTER-to-interrupt during TTS playback
4. Investigate Pi stream-json format to fix text_delta parsing (avoid fallback overhead)
5. Add configurable LLM summarization as fallback (Groq/Haiku)

## 2026-04-26: LiveKit mockup

Uses Silero VAD → OpenAI Whisper → Pi CLI → ElevenLabs TTS via LiveKit's agent framework. Web client at http://localhost:7890.

### Bug fix 1: Pi hangs when stdin is piped

Pi spawned with `stdio: ['pipe', 'pipe', 'pipe']` hangs indefinitely waiting for stdin. Fixed by using `stdio: ['ignore', 'pipe', 'pipe']`. Confirmed with isolated Node.js test.

### Test Results (after stdin fix)

Basic queries work end-to-end: speak in browser → Whisper STT → Pi `-p` → ElevenLabs TTS → hear response. Simple queries ("what is 1+1", "how's it going") complete in ~5-6s total (Pi thinking ~4-5s + TTS).

### Bug 2: Web search query dropped silently (60s timeout)

Query: "Could you use web search to find out what the weather in London is today?"

Pi received the query and started working, but the 60-second hardcoded timeout in `callPi()` killed the process (exit code 143/SIGTERM) before Pi could finish the web search. The error handler pushed "Sorry, I had trouble processing that..." to the LLM queue, but the pipeline went from "thinking" directly to "listening" without ever entering "speaking" — so the user heard nothing and the query was silently dropped.

**Root cause**: Web search involves tool calls (search, read results, synthesize) that easily exceed 60s when Pi starts fresh in `-p` mode (no persistent session).

**Fix applied**: Replaced the fixed 60s timeout with an activity-based idle timeout (120s). The timer resets whenever Pi produces stdout or stderr output, so active tool use won't be killed. Only truly stuck processes (no output for 120s) get terminated.

**Secondary issue**: Even the error fallback message wasn't spoken. The pipeline saw `completionTokens: 0` in the LLM metrics and appears to have skipped TTS entirely. This is a LiveKit framework behavior — needs investigation if we want error messages to be spoken.

### Observation: Pi `-p` mode is slow for tool use

Each query spawns a fresh `pi -p` process with no persistent session. This means Pi must:
- Start up from scratch
- Make tool calls (web search) without cached context
- Write its full response before the process exits

The RPC mode (`pi --mode rpc`) would be much better: persistent session, streaming `message_update` events, and the `steer` command for interruption. This is a known limitation of the mockup — the full product uses RPC mode per PLAN.md.

### v2 → v3 rewrite: Pi RPC + streaming spoken tags + llmNode override

Rewrote agent.ts through three iterations (v1 backed up as `livekit-pi-v1/`):

**v2: Pi RPC + spoken tag extraction**
- Switched from `pi -p` (new process per query) to `pi --mode rpc` (persistent session)
- Added `--append-system-prompt` with `<spoken>` tag instructions
- `SpokenTagParser` extracts tags from streaming `text_delta` events
- Pushed extracted tags to LiveKit's LLM queue

**v2 problems:**
1. **Concurrency bug**: when user spoke during a long-running query, the new `PiRPC.prompt()` call overwrote the event handler from the old one. The old prompt's events went to the wrong handler, and responses were silently lost.
2. **TTS timeout**: LiveKit's TTS pipeline has a 10-second idle timeout (`TTS_READ_IDLE_TIMEOUT_MS = 10_000`). If the LLM queue has content but `queue.close()` hasn't been called, TTS times out and exits. During tool calls (10-30s), no new content arrives, TTS gives up, and the pipeline goes from "thinking" to "listening" without ever entering "speaking". Confirmed via logs: `performTTSInference done` fires BEFORE `performLLMInference done`.

**v3: Agent.llmNode() override (proper LiveKit integration)**

Switched from custom `llm.LLM` subclass to overriding `Agent.llmNode()`, which returns a `ReadableStream<string>`. This is the proper LiveKit pattern for custom LLMs.

Key mechanisms:
- **Streaming spoken tags**: `text_delta` → `SpokenTagParser` → `controller.enqueue(content)` → TTS speaks immediately
- **Tool status messages**: on `tool_execution_start`, emit "Searching the web." etc. — keeps TTS alive AND informs the user
- **Keepalive**: interval checks every 3s; if no text emitted for 7s during tool calls, emits "Still working." — prevents the 10s TTS timeout
- **Interruption**: `ReadableStream.cancel()` callback aborts Pi's current operation via RPC `abort` command
- **Abort before new prompt**: `PiRPC.abortIfBusy()` sends `abort`, waits for `agent_end`, then sends new prompt

**Critical gotcha: `instanceof LLM` gate**

The pipeline's `onPreemptiveGeneration()` checks `!(this.llm instanceof LLM)` and returns early if no LLM is configured. Even with `llmNode()` overridden, the pipeline never calls it without an LLM instance. Fixed by passing a `StubLLM` (extends `llm.LLM`, throws if `chat()` is called) in the Agent constructor. The stub satisfies the `instanceof` check; `llmNode()` handles all actual work.

### v3 Test Results

Working end-to-end with streaming spoken tags:

```
15:00:59  User: "look up the weather in Berlin. And before you begin, confirm you are starting."
          Pi acknowledges: "I'm starting to look up the current weather in Berlin now."
          Pi status: "Searching the web."
15:01:26  Pi result: "Berlin is currently sunny and about 54°F / 12°C..."
```

- Simple queries (~4s): spoken tag extracted, TTS speaks immediately
- Web search (~27s total): acknowledgment spoken first, tool status bridges the gap, result spoken after
- No TTS timeout — keepalive prevents the 10s idle cutoff
- Pi session persists across queries (RPC mode) — no startup cost, full conversation context retained
- `<spoken>` tags working well — Pi wraps acknowledgments and results naturally with `--append-system-prompt`

### Steer (mid-operation redirect) — working

Implemented Pi's `steer` RPC command for redirecting the agent mid-operation. When the user speaks while Pi is busy, the new message is sent as `steer` instead of `abort` + new `prompt`. Pi finishes its current tool call, then processes the steer with full conversation context.

**Tested flow:**
```
15:43:09  User: "what the weather is like in London today?"
          Pi starts searching...
15:43:17  User: "Actually, scratch that, can you look at Berlin instead?"
          → steer sent (Pi still searching)
15:43:40  Pi: "Got it. No problem, I'll check Berlin instead. Searching the web.
          Berlin looks sunny and cool today, high around 14°C..."
```

Pi redirected from London to Berlin without losing context or restarting from scratch.

**LiveKit double-call gotcha**: LiveKit calls `llmNode` twice per user message (preemptive generation + actual turn). The second call finds Pi busy and would send a duplicate `steer`. Fixed by tracking `currentPromptText` in PiRPC — if the steer text matches the running prompt, we just take over the event handler without sending a steer command to Pi.

### Remaining issues

1. **Fallback when spoken tags are missing**: If Pi doesn't use tags, the fallback strips markdown from the full response. Works but untested in v3.
2. **Multiple concurrent tool calls**: Untested. The keepalive should handle it, but worth verifying.
3. **ElevenLabs free tier limits**: 10K chars/month. Extended testing will hit this quickly.
