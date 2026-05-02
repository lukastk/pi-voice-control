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
import { STT as OpenAISTT } from "@livekit/agents-plugin-openai";
import { TTS as ElevenLabsTTS } from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";
import { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  PiSocket,
  SteeredError,
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

type JobMetadata = {
  socketPath: string;
  appendSystemPrompt?: string; // overrides default if provided
  earcons?: EarconConfig;
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

    return new NodeReadableStream<string | llm.ChatChunk>({
      async start(controller) {
        const chunker = new SpeechChunker();
        const tagParser = new SpokenTagParser();
        let fullText = "";
        let spokenCount = 0;
        let lastEmit = Date.now();
        let toolActive = false;
        let agentStartedSpeaking = false;

        const playStartEarcon = () => {
          if (agentStartedSpeaking) return;
          agentStartedSpeaking = true;
          if (shouldPlay("copy")) playEarcon(session, "copy");
        };

        const emit = (raw: string) => {
          const cleaned = cleanForSpeech(raw);
          if (!cleaned) return;
          playStartEarcon();
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
            playStartEarcon();
            controller.enqueue(toolStatusMessage(toolName));
            lastEmit = Date.now();
          },
          onToolEnd() {
            toolActive = false;
          },
          onAgentEnd() {
            if (shouldPlay("out")) playEarcon(session, "out");
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
          } else {
            logger.error({ err }, "[VoiceBridgeAgent] error");
            controller.enqueue("Sorry, I had trouble with that. ");
          }
        } finally {
          clearInterval(keepalive);
          controller.close();
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

    const agent = new VoiceBridgeAgent(pi);
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new OpenAISTT({ model: "whisper-1", language: "en" }),
      tts: new ElevenLabsTTS({
        model: "eleven_flash_v2_5",
        voiceId: process.env.ELEVENLABS_VOICE_ID || "CwhRBWXzGAHq8TQ4Fs17",
      }),
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

    await session.start({ agent, room: ctx.room });
    logger.info("[worker] voice session started");
    session.say(
      "Hello, I'm connected to your Pi session. You can speak here or type in tmux.",
    );

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
