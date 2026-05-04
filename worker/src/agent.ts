/**
 * Voice Agent Bridge — LiveKit worker.
 *
 * Explicit dispatch: registers as agentName "voice-bridge". The Bun server
 * creates a dispatch with metadata containing the chosen Pi socket path; this
 * worker reads ctx.job.metadata in entry() and connects to that socket.
 */
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  log,
  voice,
} from "@livekit/agents";
import { STT as OpenAISTT, TTS as OpenAITTS } from "@livekit/agents-plugin-openai";
import { STT as DeepgramSTT } from "@livekit/agents-plugin-deepgram";
import { TTS as ElevenLabsTTS } from "@livekit/agents-plugin-elevenlabs";
import { TTS as CartesiaTTS } from "@livekit/agents-plugin-cartesia";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import * as fs from "node:fs";

// Diagnostic log: framework forks the agent into a subprocess whose
// stdout/stderr are piped to a parent that never reads them, so pino logs
// disappear. Writing here is the only reliable way to inspect a session
// after the fact. appendFileSync with O_APPEND is atomic for line-sized
// writes on macOS/Linux, so the parent's tee and our subprocess writes
// can coexist without interleaving.
const DIAG_LOG_PATH = "/tmp/voice-bridge-worker.log";
export function diagLog(msg: string, fields?: Record<string, unknown>) {
  try {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), msg, ...(fields ?? {}) }) + "\n";
    fs.appendFileSync(DIAG_LOG_PATH, line);
  } catch {
    // best-effort; never let diagnostics fail the session
  }
}

import {
  PiSocket,
  SteeredError,
  PiSessionEndedError,
  type PiCallbacks,
} from "./pi-bridge.ts";
import {
  SpokenTagParser,
  cleanForSpeech,
  toolStatusMessage,
  SPOKEN_TAG_PROMPT,
} from "./text.ts";
import { playEarcon, setEarconVolume } from "./earcons.ts";

type SpeechHandle = ReturnType<voice.AgentSession["say"]>;

const AGENT_NAME = "voice-bridge";

type EarconConfig = {
  enabled: boolean;
  over: boolean;
  copy: boolean;
  out: boolean;
  volume: number;
};

type SttConfig = {
  provider: "openai-whisper" | "deepgram";
  model: string;
  language: string;
};

type TtsConfig = {
  provider: "elevenlabs" | "openai" | "cartesia";
  model: string;
  voiceId: string;
};

type JobMetadata = {
  socketPath: string;
  appendSystemPrompt?: string; // overrides default if provided
  earcons?: EarconConfig;
  stt?: SttConfig;
  tts?: TtsConfig;
};

const DEFAULT_EARCONS: EarconConfig = {
  enabled: true,
  over: true,
  copy: true,
  out: true,
  volume: 1,
};

let activeEarcons: EarconConfig = DEFAULT_EARCONS;

function shouldPlay(kind: "over" | "copy" | "out"): boolean {
  if (!activeEarcons.enabled) return false;
  if (kind === "over") return activeEarcons.over;
  if (kind === "copy") return activeEarcons.copy;
  return activeEarcons.out;
}

function parseMetadata(raw: string | undefined): JobMetadata {
  if (!raw) {
    throw new Error(
      "Worker started without job metadata. Server must dispatch with {socketPath} metadata.",
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.socketPath !== "string") {
      throw new Error("metadata.socketPath missing");
    }
    return parsed as JobMetadata;
  } catch (e: any) {
    throw new Error(`Invalid job metadata: ${e.message}`);
  }
}

class StubLLM extends llm.LLM {
  label() {
    return "voice-bridge-stub";
  }
  get model() {
    return "pi";
  }
  get provider() {
    return "voice-bridge";
  }
  chat(): llm.LLMStream {
    throw new Error("StubLLM.chat() should never be called");
  }
}

/**
 * VoiceBridgeAgent
 *
 * Bridges a LiveKit voice session to a Pi coding-agent socket.
 *
 * Architecture (v2): each Pi `<spoken>` tag becomes its own
 * `session.say()` call rather than chunks of one streaming TTS.
 *
 * Why: the framework's pipelineReply is built around a streaming LLM and
 * force-closes the TTS pipeline if no audio frames flow for 10s
 * (TTS_READ_IDLE_TIMEOUT_MS, hardcoded in voice/generation.js). Pi
 * produces bursty content with multi-second tool gaps between spoken
 * tags, so any turn longer than the timeout silently dropped everything
 * after the first tag. Per-tag `say()` sidesteps the issue: each TTS
 * stream lives only as long as one bounded utterance, the timeout never
 * has the chance to fire.
 *
 * llmNode therefore returns null after awaiting Pi (short-circuiting the
 * framework's LLM/TTS tasks at generation.js:334-337 and 454-460) while
 * dispatching `session.say()` from the Pi callbacks. Each spoken tag is an
 * independent SpeechHandle queued on the AgentSession's mainTask.
 *
 * Interruption: the framework auto-interrupts whichever say-handle is the
 * current speech. Queued say-handles for the abandoned Pi turn need
 * explicit cleanup via #interruptPendingSays() so they don't play after
 * the user has moved on.
 */
class VoiceBridgeAgent extends voice.Agent {
  #pi: PiSocket;
  #pendingSays: SpeechHandle[] = [];

  constructor(pi: PiSocket) {
    super({
      instructions:
        "You are a voice bridge to a Pi coding-agent TUI session. " +
        "Forward the user's spoken request to Pi and speak Pi's streamed response.",
      llm: new StubLLM(),
    });
    this.#pi = pi;
  }

  /** Schedule a spoken utterance on the session, tracked so we can
   * interrupt it if the user barges in before it plays. */
  #scheduleSay(text: string): void {
    const cleaned = cleanForSpeech(text);
    if (!cleaned) return;
    const handle = this.session.say(cleaned, { allowInterruptions: true });
    this.#pendingSays.push(handle);
    handle.addDoneCallback((sh) => {
      this.#pendingSays = this.#pendingSays.filter((h) => h !== sh);
    });
    diagLog("scheduleSay", { id: handle.id, len: cleaned.length, preview: cleaned.slice(0, 60) });
  }

  /** Interrupt every queued/in-flight say-handle from the current Pi turn.
   * Called when the user barges in: the framework only interrupts the
   * current speech, not items still in the speech queue. */
  #interruptPendingSays(): void {
    const count = this.#pendingSays.length;
    if (count === 0) return;
    for (const h of this.#pendingSays) {
      if (!h.done() && !h.interrupted) {
        try {
          h.interrupt();
        } catch {
          // Some handles refuse interruption (e.g. allowInterruptions=false).
          // Earcons are interruptible; this is just defensive.
        }
      }
    }
    this.#pendingSays = [];
    diagLog("interruptPendingSays", { count });
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    _toolCtx: llm.ToolContext,
    _modelSettings: voice.ModelSettings,
  ): Promise<NodeReadableStream<string | llm.ChatChunk> | null> {
    const logger = log();

    let userText = "";
    for (let i = chatCtx.items.length - 1; i >= 0; i--) {
      const item = chatCtx.items[i];
      if (item?.type === "message" && item.role === "user") {
        if (Array.isArray(item.content)) {
          userText = item.content
            .filter((c: unknown): c is string => typeof c === "string")
            .join(" ");
        }
        break;
      }
    }

    if (!userText) return null;

    const pi = this.#pi;
    const session = this.session;
    const isInterruption = pi.isBusy;

    logger.info({ userText, isInterruption }, "[VoiceBridgeAgent] llmNode");
    diagLog("llmNode start", { userText, isInterruption });

    if (isInterruption) {
      this.#interruptPendingSays();
      pi.abandonCurrentPrompt();
    }

    if (isInterruption && userText !== pi.currentPromptText) {
      this.#scheduleSay("Got it.");
    }

    const tagParser = new SpokenTagParser();
    let fullText = "";
    let spokenCount = 0;
    let deltaCount = 0;

    const callbacks: PiCallbacks = {
      onTextDelta: (delta) => {
        deltaCount++;
        fullText += delta;
        for (const tag of tagParser.feed(delta)) {
          spokenCount++;
          logger.info(
            { len: tag.length, preview: tag.slice(0, 60) },
            "[VoiceBridgeAgent] <spoken> tag → say",
          );
          this.#scheduleSay(tag);
        }
      },
      onToolStart: (toolName) => {
        this.#scheduleSay(toolStatusMessage(toolName));
      },
      onToolEnd: () => {},
      onAgentEnd: () => {
        // Fallback: Pi finished without ever wrapping content in <spoken>.
        // Defensive — well-behaved Pi sessions follow the system prompt.
        if (spokenCount === 0 && fullText.trim()) {
          logger.warn(
            { fullTextLen: fullText.length, deltaCount },
            "[VoiceBridgeAgent] no <spoken> tags — falling back to cleaned full text",
          );
          this.#scheduleSay(fullText);
        }
        diagLog("pi turn complete", {
          deltaCount,
          fullTextLen: fullText.length,
          spokenCount,
        });
        if (shouldPlay("out")) playEarcon(session, "out");
      },
    };

    // CRITICAL: do NOT await pi.prompt here.
    //
    // We're inside llmNode, which is awaited by the framework's
    // performLLMInference, which is inside pipelineReply. While pipelineReply
    // owns _currentSpeech, the AgentSession mainTask is blocked at
    // _waitForGeneration() and cannot pop new SpeechHandles off the queue.
    //
    // If we awaited pi.prompt, every session.say() we scheduled from
    // callbacks would queue up but not play until Pi's whole turn finished —
    // defeating the point of progressive playback.
    //
    // Instead, start Pi in the background and return null immediately.
    // pipelineReply then short-circuits both LLM and TTS paths
    // (generation.js:334-337, 454-460), marks its speech handle done in a
    // few ms, and mainTask is free to pick up our queued say-handles as
    // they arrive.
    pi.prompt(userText, callbacks, isInterruption).catch((err) => {
      if (err instanceof SteeredError) {
        logger.info("[VoiceBridgeAgent] pi turn steered (interrupted)");
        diagLog("pi turn steered");
      } else if (err instanceof PiSessionEndedError) {
        logger.warn("[VoiceBridgeAgent] Pi session has ended");
        this.#scheduleSay(
          "The Pi session has ended. Pick another one in the sessions tab.",
        );
      } else {
        logger.error({ err }, "[VoiceBridgeAgent] pi error");
        diagLog("pi error", { message: (err as Error)?.message });
        this.#scheduleSay("Sorry, I had trouble with that.");
      }
    });

    return null;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
    log().info("[worker] Silero VAD prewarmed");
  },

  entry: async (ctx: JobContext) => {
    const logger = log();
    const meta = parseMetadata(ctx.job.metadata);
    activeEarcons = { ...DEFAULT_EARCONS, ...(meta.earcons ?? {}) };
    setEarconVolume(activeEarcons.volume);
    logger.info(
      { socketPath: meta.socketPath, earcons: activeEarcons },
      "[worker] entry",
    );
    diagLog("=== session entry ===", { socketPath: meta.socketPath, earcons: activeEarcons, jobId: ctx.job.id });

    await ctx.connect();
    logger.info("[worker] connected to LiveKit room");

    const pi = new PiSocket(meta.socketPath);
    await pi.connect();

    pi.appendSystemPrompt(meta.appendSystemPrompt ?? SPOKEN_TAG_PROMPT);

    const sttCfg = meta.stt ?? { provider: "openai-whisper", model: "whisper-1", language: "en" };
    const stt =
      sttCfg.provider === "deepgram"
        ? new DeepgramSTT({
            model: (sttCfg.model || "nova-3") as any,
            language: sttCfg.language || "en",
          })
        : new OpenAISTT({
            model: (sttCfg.model || "whisper-1") as any,
            language: sttCfg.language || "en",
          });
    logger.info({ stt: sttCfg }, "[worker] STT configured");

    const ttsCfg =
      meta.tts ?? {
        provider: "elevenlabs",
        model: "eleven_flash_v2_5",
        voiceId: process.env.ELEVENLABS_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17",
      };
    let tts: any;
    if (ttsCfg.provider === "openai") {
      tts = new OpenAITTS({
        model: (ttsCfg.model || "gpt-4o-mini-tts") as any,
        voice: (ttsCfg.voiceId || "alloy") as any,
      });
    } else if (ttsCfg.provider === "cartesia") {
      tts = new CartesiaTTS({
        model: (ttsCfg.model || "sonic-3") as any,
        voice: ttsCfg.voiceId || undefined,
      });
    } else {
      tts = new ElevenLabsTTS({
        model: (ttsCfg.model || "eleven_flash_v2_5") as any,
        voiceId: ttsCfg.voiceId || "CwhRBWXzGAHq8TQ4Fs17",
      });
    }
    logger.info({ tts: ttsCfg }, "[worker] TTS configured");

    const agent = new VoiceBridgeAgent(pi);
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt,
      tts,
      // Disable false-interruption resume.
      //
      // The framework's "false interruption" feature pauses the agent's
      // speech when VAD picks up a brief blip, then resumes after a
      // timeout if no real transcript followed. It's the only thing that
      // sets `pausedSpeech`, and `pausedSpeech` is what powers a buggy
      // chain in the framework's `userTurnCompleted`:
      //
      //   - line 1215: `if (this._currentSpeech) { ... `
      //   - line 1223: `await this.cancelSpeechPause()` ← yields
      //     during which cancelSpeechPause calls
      //     `pausedSpeech.handle.interrupt()`. When that handle is the
      //     same object as `_currentSpeech` (the common case), the
      //     interrupt resolves mainTask's `waitIfNotInterrupted` race
      //     and mainTask sets `_currentSpeech = void 0` *during* the
      //     await.
      //   - line 1228: `this._currentSpeech.interrupt()` ← TypeError
      //     (read of `interrupt` on undefined).
      //
      // The throw rejects the userTurnCompleted task. The next user
      // turn's task awaits the previous one via `oldTask.result`,
      // rethrows, never reaches `generateReply`. Cascade. No more
      // replies for the rest of the session. Diagnostic capture in
      // /tmp/voice-bridge-worker.log shows exactly this pattern: STT
      // and earcons keep working, generate_reply silently stops firing.
      //
      // Disabling resumeFalseInterruption makes `pauseEnabled()` return
      // false, so `pausedSpeech` is never set and the racy code path is
      // never entered. We don't want false-interruption-resume anyway —
      // every barge-in in this voice agent is intentional, the user
      // expects the agent to stop talking, period.
      //
      // The framework bug should still be fixed upstream (an optional
      // chain on line 1228 plus a try/catch around the oldTask.result
      // chain), but our code shouldn't depend on that landing.
      turnHandling: {
        interruption: {
          resumeFalseInterruption: false,
        },
      },
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      logger.info({ transcript: ev.transcript }, "[worker] user");
      const final =
        (ev as { final?: boolean }).final ??
        (ev as { isFinal?: boolean }).isFinal ??
        true;
      diagLog("user transcript", { transcript: ev.transcript, final });
      if (!final) return;
      if (shouldPlay("over")) playEarcon(session, "over");
    });

    // Lifecycle traces for /tmp/voice-bridge-worker.log.
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev: any) => {
      diagLog("agent state", { from: ev.oldState, to: ev.newState });
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev: any) => {
      const handle = ev.speechHandle;
      if (!handle) return;
      const startedAt = Date.now();
      diagLog("speech created", {
        id: handle.id,
        source: ev.source,
        allowInterruptions: handle.allowInterruptions,
        userInitiated: ev.userInitiated,
      });
      handle.addDoneCallback?.((sh: any) => {
        diagLog("speech done", {
          id: sh.id,
          source: ev.source,
          elapsedMs: Date.now() - startedAt,
          interrupted: sh.interrupted,
        });
      });
    });

    // Surface STT/TTS/LLM errors from the AgentSession back to the browser
    // via the LiveKit data channel. The client subscribes to DataReceived
    // and renders a toast — important because TTS errors are otherwise
    // silent (no spoken output, no obvious feedback in the UI).
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const err = (ev as any).error;
      const source = (ev as any).source;
      const sourceLabel: string =
        source?.label ?? source?.provider ?? source?.constructor?.name ?? "unknown";
      const message: string =
        err?.error?.message ?? err?.message ?? err?.reason ?? String(err ?? "unknown error");
      // Skip the well-known LiveKit Cloud adaptive-interruption 401 — it's
      // expected when the user hasn't enabled that feature, and we already
      // fall back to local VAD-based interruption.
      if (sourceLabel.includes("AdaptiveInterruption")) return;
      logger.warn({ source: sourceLabel, message }, "[worker] surfacing error to client");
      diagLog("session error", { source: sourceLabel, message });
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ kind: "error", source: sourceLabel, message }),
        );
        ctx.room.localParticipant?.publishData(payload, { reliable: true, topic: "voice-bridge" });
      } catch (e: any) {
        logger.error({ err: e }, "[worker] publishData failed");
      }
    });

    await session.start({ agent, room: ctx.room });
    logger.info("[worker] voice session started");
    // No spoken greeting — play a short ascending tone instead so the user
    // gets an unambiguous "voice connected" cue without TTS chatter.
    if (activeEarcons.enabled) playEarcon(session, "connect");

    ctx.room.on("disconnected", () => {
      logger.info("[worker] room disconnected — closing Pi socket");
      pi.close();
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
  }),
);
