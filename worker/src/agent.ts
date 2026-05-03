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

import {
  PiSocket,
  SteeredError,
  PiSessionEndedError,
  type PiCallbacks,
} from "./pi-bridge.ts";
import {
  SpokenTagParser,
  SpeechChunker,
  cleanForSpeech,
  toolStatusMessage,
  SPOKEN_TAG_PROMPT,
} from "./text.ts";
import { playEarcon, setEarconVolume } from "./earcons.ts";

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

class VoiceBridgeAgent extends voice.Agent {
  #pi: PiSocket;

  constructor(pi: PiSocket) {
    super({
      instructions:
        "You are a voice bridge to a Pi coding-agent TUI session. " +
        "Forward the user's spoken request to Pi and speak Pi's streamed response.",
      llm: new StubLLM(),
    });
    this.#pi = pi;
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

    // Track whether we should play "out" after the LLM stream closes.
    // Important: do NOT call session.say() for earcons during the LLM
    // stream — scheduling a new SpeechHandle while pipelineReply is the
    // current speech disrupts pipelineReply's progressive TTS playback,
    // and the user only hears the assistant's reply at the very end.
    let playOutAfterStreamClose = false;

    return new NodeReadableStream<string | llm.ChatChunk>({
      async start(controller) {
        const chunker = new SpeechChunker();
        const tagParser = new SpokenTagParser();
        let fullText = "";
        let spokenCount = 0;
        let lastEmit = Date.now();
        let toolActive = false;

        const emit = (raw: string) => {
          const cleaned = cleanForSpeech(raw);
          if (!cleaned) return;
          controller.enqueue(cleaned + " ");
          lastEmit = Date.now();
        };

        const callbacks: PiCallbacks = {
          onTextDelta(delta) {
            fullText += delta;
            for (const tag of tagParser.feed(delta)) {
              spokenCount++;
              emit(tag);
            }
          },
          onToolStart(toolName) {
            toolActive = true;
            controller.enqueue(toolStatusMessage(toolName));
            lastEmit = Date.now();
          },
          onToolEnd() {
            toolActive = false;
          },
          onAgentEnd() {
            // Defer "out" earcon — fired below after controller.close() so
            // its SpeechHandle queues behind a fully-completed pipelineReply.
            if (shouldPlay("out")) playOutAfterStreamClose = true;
          },
        };

        const keepalive = setInterval(() => {
          if (toolActive && Date.now() - lastEmit > 7000) {
            controller.enqueue("Still working. ");
            lastEmit = Date.now();
          }
        }, 3000);

        try {
          if (isInterruption && userText !== pi.currentPromptText) {
            controller.enqueue("Got it. ");
            lastEmit = Date.now();
          }
          await pi.prompt(userText, callbacks, isInterruption);

          if (spokenCount === 0 && fullText.trim()) {
            logger.warn("[VoiceBridgeAgent] no <spoken> tags — falling back to cleaned text");
            for (const chunk of chunker.feed(fullText)) emit(chunk);
            for (const chunk of chunker.flush()) emit(chunk);
          }
        } catch (err) {
          if (err instanceof SteeredError) {
            logger.info("[VoiceBridgeAgent] interrupted by newer voice turn");
          } else if (err instanceof PiSessionEndedError) {
            logger.warn("[VoiceBridgeAgent] Pi session has ended");
            controller.enqueue(
              "The Pi session has ended. Pick another one in the sessions tab. ",
            );
          } else {
            logger.error({ err }, "[VoiceBridgeAgent] error");
            controller.enqueue("Sorry, I had trouble with that. ");
          }
        } finally {
          clearInterval(keepalive);
          controller.close();
          // Now that pipelineReply has consumed close(), it will finish on
          // its own. Queueing the "out" earcon here means it lands behind a
          // pipelineReply that is already wrapping up, not one mid-stream.
          if (playOutAfterStreamClose) {
            // Small delay to ensure pipelineReply's TTS has truly drained
            // before we enqueue another SpeechHandle.
            setTimeout(() => playEarcon(session, "out"), 200);
          }
        }
      },
      cancel() {
        // LiveKit cancels the LLM stream when the user interrupts (barge-in
        // or new turn). We don't abort Pi — the next llmNode call will steer.
        log().info("[VoiceBridgeAgent] stream cancelled");
        pi.abandonCurrentPrompt();
      },
    });
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
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      logger.info({ transcript: ev.transcript }, "[worker] user");
      // "Over" — fires on every transcription, but session.say queues so
      // partial transcripts simply chain a tiny earcon each. Keep to final.
      const isFinal =
        (ev as { final?: boolean }).final ??
        (ev as { isFinal?: boolean }).isFinal ??
        true;
      if (isFinal && shouldPlay("over")) playEarcon(session, "over");
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
