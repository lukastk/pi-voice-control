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
import { RoomEvent } from "@livekit/rtc-node";
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
import { GatedSTT } from "./gated_stt.ts";

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
  vocabulary?: string[];
};

type TtsConfig = {
  provider: "elevenlabs" | "openai" | "cartesia";
  model: string;
  voiceId: string;
};

type TurnMode = "vad" | "manual" | "keyword";

type KeywordConfig = {
  start: string[];
  end: string[];
  scrap: string[];
  redo: string[];
  replay: string[];
  abort: string[];
  matchThreshold: number;
  maxArmedSeconds: number;
};

type KeywordGatingConfig = {
  enabled: boolean;
  prerollMs: number;
  hangoverMs: number;
  activationThreshold: number;
  minSpeechDurationMs: number;
  minSilenceDurationMs: number;
  prefixPaddingMs: number;
};

type JobMetadata = {
  socketPath: string;
  appendSystemPrompt?: string; // overrides default if provided
  earcons?: EarconConfig;
  stt?: SttConfig;
  tts?: TtsConfig;
  turnMode?: TurnMode;
  keywords?: KeywordConfig;
  keywordGating?: KeywordGatingConfig;
};

const DEFAULT_KEYWORD_GATING: KeywordGatingConfig = {
  enabled: true,
  prerollMs: 300,
  hangoverMs: 600,
  activationThreshold: 0.5,
  minSpeechDurationMs: 50,
  minSilenceDurationMs: 550,
  prefixPaddingMs: 500,
};

const DEFAULT_EARCONS: EarconConfig = {
  enabled: true,
  over: true,
  copy: true,
  out: true,
  volume: 1,
};

let activeEarcons: EarconConfig = DEFAULT_EARCONS;

const DEFAULT_KEYWORDS: KeywordConfig = {
  start: ["Pi, come in"],
  end: ["Pi, that's all"],
  scrap: ["Pi, scrap that"],
  redo: ["Pi, do over"],
  replay: ["Pi, say again"],
  abort: ["Pi, abort"],
  matchThreshold: 0.75,
  maxArmedSeconds: 60,
};

let activeTurnMode: TurnMode = "vad";
let activeKeywords: KeywordConfig = DEFAULT_KEYWORDS;

/** Standard Levenshtein distance, two-row dynamic programming. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Find the best match of `keyword` inside `transcript` using token-level
 * fuzzy matching. Slides word windows of size N±1 (where N = keyword
 * word count) and scores each via Levenshtein. Returns the [start, end)
 * char range in the original transcript if best score >= threshold,
 * else null. Threshold of 1.0 effectively requires exact match.
 *
 * Token-level (rather than raw char-level) so a single mistranscribed
 * word like "high" → "pi" doesn't tank the score for the whole phrase.
 */
function findKeyword(
  transcript: string,
  keyword: string,
  threshold: number,
): { range: [number, number]; score: number } | null {
  const tNorm = normalizeForMatch(transcript);
  const kNorm = normalizeForMatch(keyword);
  if (!tNorm || !kNorm) return null;

  const tWords = tNorm.split(" ");
  const kWords = kNorm.split(" ");
  const k = kWords.length;

  let bestScore = 0;
  let bestWindow: [number, number] | null = null;

  const sizes = new Set([Math.max(1, k - 1), k, k + 1]);
  for (const winSize of sizes) {
    if (winSize > tWords.length) continue;
    for (let start = 0; start + winSize <= tWords.length; start++) {
      const window = tWords.slice(start, start + winSize).join(" ");
      const dist = levenshtein(window, kNorm);
      const maxLen = Math.max(window.length, kNorm.length);
      const score = maxLen === 0 ? 0 : 1 - dist / maxLen;
      if (score > bestScore) {
        bestScore = score;
        bestWindow = [start, start + winSize];
      }
    }
  }

  if (bestScore < threshold || !bestWindow) return null;

  // Map the normalized word window back to char positions in the
  // original transcript. We walk the original looking for word
  // boundaries (alphanumeric runs).
  const wordSpans: { start: number; end: number }[] = [];
  let inWord = false;
  let wordStart = 0;
  for (let i = 0; i < transcript.length; i++) {
    const isAlnum = /[a-z0-9]/i.test(transcript[i]!);
    if (isAlnum && !inWord) {
      inWord = true;
      wordStart = i;
    } else if (!isAlnum && inWord) {
      inWord = false;
      wordSpans.push({ start: wordStart, end: i });
    }
  }
  if (inWord) wordSpans.push({ start: wordStart, end: transcript.length });

  if (bestWindow[0] >= wordSpans.length || bestWindow[1] > wordSpans.length) {
    // Defensive: word counts mismatched (shouldn't happen with our
    // normalization, but be robust).
    return null;
  }
  return {
    range: [wordSpans[bestWindow[0]]!.start, wordSpans[bestWindow[1] - 1]!.end],
    score: bestScore,
  };
}

/** Try each alternative keyword in turn; return the best-scoring
 *  match across all of them, or null if none clear the threshold.
 *  "Best" rather than "first" so the diag log surfaces the winning
 *  variant rather than whichever happened to be first in the array. */
function findAnyKeyword(
  transcript: string,
  keywords: string[],
  threshold: number,
): { range: [number, number]; score: number; matched: string } | null {
  let best: { range: [number, number]; score: number; matched: string } | null = null;
  for (const k of keywords) {
    if (!k.trim()) continue;
    const m = findKeyword(transcript, k, threshold);
    if (m && (!best || m.score > best.score)) {
      best = { range: m.range, score: m.score, matched: k };
    }
  }
  return best;
}

function stripKeywords(text: string): string {
  let out = text;

  // Stripping uses a more permissive threshold than detection. Detection
  // ran on partial transcripts and has to avoid false fires, so it sits
  // at a higher bar (default 0.75). By the time the framework finalizes
  // and commits, the polished transcript can differ from the partial that
  // triggered detection — STT may drop "Pi" entirely, or render it as
  // "K", "Kit", "high", etc. — and the polished version can fall below
  // the detection threshold even though we know the keyword was spoken.
  // A lower strip threshold cleans up these mishearings without affecting
  // detection sensitivity. Floor at 0.4 so it doesn't degrade into
  // matching arbitrary noise.
  const stripThreshold = Math.max(activeKeywords.matchThreshold - 0.25, 0.4);

  // Start phrase: drop everything from the beginning of the transcript
  // through the end of the match. Anything before the start phrase is
  // pre-keyword speech the user happened to make before triggering the
  // agent — clearly not part of the message they intended to send.
  const startMatch = findAnyKeyword(out, activeKeywords.start, stripThreshold);
  if (startMatch) out = out.slice(startMatch.range[1]);

  // End phrase: drop from the start of the match through the end of the
  // transcript. The user said "...Pi, that's all" and wants the trailer
  // gone whether or not it transcribed perfectly.
  const endMatch = findAnyKeyword(out, activeKeywords.end, stripThreshold);
  if (endMatch) out = out.slice(0, endMatch.range[0]);

  // Defensive: if a scrap/redo/replay phrase somehow ended up in a
  // committed transcript that reached llmNode, excise it (single match).
  // These almost never need stripping in practice — the keyword
  // handlers commit-and-drop those turns before llmNode runs — but a
  // weird interleaving (say, partial that didn't quite trigger
  // detection but appeared in the polished transcript) could let one
  // through.
  for (const list of [activeKeywords.scrap, activeKeywords.redo, activeKeywords.replay, activeKeywords.abort]) {
    const m = findAnyKeyword(out, list, stripThreshold);
    if (m) out = (out.slice(0, m.range[0]) + " " + out.slice(m.range[1])).trim();
  }

  // Asymmetric trim: leading commas/dots/etc. are almost always artifacts
  // of keyword excision (e.g. residual "." after stripping "Pi, come in"),
  // but trailing terminal punctuation (.!?) is usually the user's real
  // sentence ending and should be preserved. So only strip
  // commas/semicolons/colons + whitespace from the right edge.
  return out
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:!?]+/, "")
    .replace(/[\s,;:]+$/, "")
    .trim();
}

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
  // Set true before commitUserTurn() when keyword-mode "scrap" / "redo"
  // / "replay" fires, so the next llmNode invocation drops the turn
  // instead of forwarding the (just-cleared) transcript to Pi. Single-
  // shot — llmNode resets it on the way out.
  #dropNextTurn = false;
  // Spoken-tag content from the most recent completed Pi turn. Used by
  // the keyword-mode "replay" command to re-speak the last response.
  #lastResponseChunks: string[] = [];

  constructor(pi: PiSocket) {
    super({
      instructions:
        "You are a voice bridge to a Pi coding-agent TUI session. " +
        "Forward the user's spoken request to Pi and speak Pi's streamed response.",
      llm: new StubLLM(),
    });
    this.#pi = pi;
  }

  /** Schedule the previous turn's spoken chunks again. Used by the
   *  keyword-mode "replay" command. No-op if there hasn't been a turn
   *  yet (or the previous turn produced no spoken content). */
  replayLastResponse(): boolean {
    if (this.#lastResponseChunks.length === 0) return false;
    diagLog("replay last response", { chunks: this.#lastResponseChunks.length });
    for (const chunk of this.#lastResponseChunks) {
      this.#scheduleSay(chunk);
    }
    return true;
  }

  /** Mark the next user turn for discard. The framework will still
   *  call llmNode for the in-flight transcript, but llmNode short-
   *  circuits and returns null without forwarding to Pi. */
  markDropNext(): void {
    this.#dropNextTurn = true;
  }

  /** Speak a short feedback message (e.g. "Nothing to replay yet.").
   *  Same plumbing as a Pi spoken tag — uses the trackable
   *  #pendingSays queue so an interrupt can cancel it. */
  sayFeedback(text: string): void {
    this.#scheduleSay(text);
  }

  /** Abort whatever Pi is currently doing (escape-key equivalent
   *  in the TUI), interrupt any speech the agent is in the middle
   *  of, and clear our local pi-prompt state. Called from the
   *  keyword-mode "abort" command. */
  abortCurrent(): void {
    this.#interruptPendingSays();
    this.#pi.abort();
    // Reject the in-flight pi.prompt() so its .catch handler runs
    // and the next user turn doesn't think we're still busy. The
    // background pi.prompt promise rejects with SteeredError which
    // we already handle silently.
    this.#pi.abandonCurrentPrompt();
    diagLog("abortCurrent");
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

    // Single-shot drop flag set by the keyword-mode "scrap" / "redo" /
    // "replay" handlers. The framework still ran a user turn (so its
    // audioTranscript got reset cleanly), but we don't want to forward
    // anything to Pi for it.
    if (this.#dropNextTurn) {
      this.#dropNextTurn = false;
      diagLog("llmNode drop (keyword command)");
      return null;
    }

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

    // In keyword mode the transcript still contains the start/end phrases
    // (the framework's STT layer captures everything between mic-open and
    // commitUserTurn). Strip them before forwarding to Pi so it doesn't
    // see "Pi, come in what's the weather Pi, that's all" as the message.
    if (activeTurnMode === "keyword") {
      const cleaned = stripKeywords(userText);
      if (cleaned !== userText) {
        diagLog("keyword strip", { before: userText, after: cleaned });
        userText = cleaned;
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
    // Accumulate this turn's spoken chunks (plus any fallback) so the
    // keyword-mode "replay" command can re-speak them later. Only
    // populated for cleanly-completed turns — interrupted turns
    // intentionally leave #lastResponseChunks pointing at the previous
    // intact response.
    const turnChunks: string[] = [];

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
          turnChunks.push(tag);
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
          turnChunks.push(fullText);
        }
        if (turnChunks.length > 0) this.#lastResponseChunks = turnChunks;
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
    activeTurnMode = meta.turnMode ?? "vad";
    activeKeywords = { ...DEFAULT_KEYWORDS, ...(meta.keywords ?? {}) };
    logger.info(
      { socketPath: meta.socketPath, earcons: activeEarcons, turnMode: activeTurnMode, keywords: activeKeywords },
      "[worker] entry",
    );
    diagLog("=== session entry ===", {
      socketPath: meta.socketPath,
      earcons: activeEarcons,
      turnMode: activeTurnMode,
      keywords: activeTurnMode === "keyword" ? activeKeywords : undefined,
      jobId: ctx.job.id,
    });

    await ctx.connect();
    logger.info("[worker] connected to LiveKit room");

    const pi = new PiSocket(meta.socketPath);
    await pi.connect();

    pi.appendSystemPrompt(meta.appendSystemPrompt ?? SPOKEN_TAG_PROMPT);

    // Hoisted ahead of STT construction so the GatedSTT bypass closure
    // can read it. Flipped true between start-keyword detection and turn
    // commit; while true the gate is bypassed (every frame goes to
    // Deepgram) so quiet words mid-command can't be VAD-gated out.
    let keywordArmed = false;

    const sttCfg = meta.stt ?? { provider: "openai-whisper", model: "whisper-1", language: "en" };
    // Custom vocabulary. Both providers expose a way to bias toward
    // proper nouns/jargon. We send the same list either way; provider
    // adapter below picks the right param.
    const vocab = (sttCfg.vocabulary ?? []).filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    const dgModel = sttCfg.model || "nova-3";
    // keyterm/keywords are mutually exclusive by model: Nova-3 ONLY
    // accepts `keyterm` (English-only, no weight) and 400s on `keywords`
    // ("Keywords are not supported for Nova-3"); Nova-2 and older ONLY
    // accept `keywords` (term:weight). Pick by model rather than sending
    // both.
    const dgIsNova3 = dgModel.toLowerCase().startsWith("nova-3");
    const baseStt =
      sttCfg.provider === "deepgram"
        ? new DeepgramSTT({
            model: dgModel as any,
            language: sttCfg.language || "en",
            ...(vocab.length > 0
              ? dgIsNova3
                ? { keyterm: vocab }
                : { keywords: vocab.map((t) => [t, 1] as [string, number]) }
              : {}),
          })
        : new OpenAISTT({
            model: (sttCfg.model || "whisper-1") as any,
            language: sttCfg.language || "en",
            // Whisper soft-bias via prompt. Comma-separated proper
            // nouns is the documented pattern.
            ...(vocab.length > 0 ? { prompt: vocab.join(", ") } : {}),
          });

    // VAD-gate the STT in keyword mode + Deepgram. Keyword mode in
    // particular streams audio whenever the room is open — without
    // gating, a quiet workspace racks up Deepgram billing for silence.
    // Other modes already commit short utterances explicitly, so the
    // wrapper buys us nothing there.
    const gatingCfg: KeywordGatingConfig = {
      ...DEFAULT_KEYWORD_GATING,
      ...(meta.keywordGating ?? {}),
    };
    const useGating =
      activeTurnMode === "keyword" &&
      sttCfg.provider === "deepgram" &&
      gatingCfg.enabled;

    if (useGating) {
      // Apply user-tunable Silero options before any new stream is
      // created. updateOptions also reaches existing streams (e.g. the
      // framework's own VAD use), which is intentional — there's only
      // one VAD instance per process, and the keyword-mode gating
      // settings are the user's deliberate choice.
      (ctx.proc.userData.vad as silero.VAD).updateOptions({
        activationThreshold: gatingCfg.activationThreshold,
        minSpeechDuration: gatingCfg.minSpeechDurationMs,
        minSilenceDuration: gatingCfg.minSilenceDurationMs,
        prefixPaddingDuration: gatingCfg.prefixPaddingMs,
      });
    }

    const stt = useGating
      ? new GatedSTT({
          inner: baseStt,
          vad: ctx.proc.userData.vad as silero.VAD,
          prerollMs: gatingCfg.prerollMs,
          hangoverMs: gatingCfg.hangoverMs,
          isBypassed: () => keywordArmed,
          onDiag: (msg, fields) => diagLog(msg, fields),
        })
      : baseStt;
    logger.info(
      { stt: sttCfg, gating: useGating ? gatingCfg : null },
      "[worker] STT configured",
    );

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
        // In keyword (and manual) mode, disable framework auto-EOU so we
        // commit user turns explicitly via session.commitUserTurn() —
        // either when the end keyword is spotted in the transcript stream
        // (keyword mode), or when the client sends an explicit signal
        // (manual mode, when wired up). With turnDetection undefined the
        // framework uses VAD/STT auto detection, which is what we want
        // for the default "vad" mode.
        turnDetection: activeTurnMode === "vad" ? undefined : "manual",
      },
    });

    // Keyword-mode state. The framework still runs STT in manual mode and
    // emits UserInputTranscribed (interim + final) — we just have to scan
    // those for the start/end phrases ourselves and call commitUserTurn().
    // (keywordArmed is declared above STT construction so the GatedSTT
    // bypass closure can read it.)
    // Time-based dedup for replay. The replay phrase stays in the
    // framework's audioTranscript until commitUserTurn's downstream EOU
    // path clears it (a few hundred ms). Without this guard, every STT
    // partial that still contains the replay phrase fires another
    // replay, stacking duplicate playback.
    let lastReplayFireAt = 0;
    // Same dedup mechanism for abort. Without it, every STT partial
    // that still contains the abort phrase would fire pi.abort()
    // repeatedly until the audioTranscript clears.
    let lastAbortFireAt = 0;

    // Publish a voice-state change to the client over the LiveKit data
    // channel. Used today for the keyword-mode "armed" indicator in the
    // top bar; future state can ride the same kind="voice-state" topic.
    const publishVoiceState = (state: Record<string, unknown>) => {
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ kind: "voice-state", ...state }),
        );
        ctx.room.localParticipant?.publishData(payload, {
          reliable: true,
          topic: "voice-bridge",
        });
      } catch (e: any) {
        logger.error({ err: e }, "[worker] publishVoiceState failed");
      }
    };

    // Auto-scrap timer: if a keyword turn stays armed past
    // activeKeywords.maxArmedSeconds, force-scrap it. Guards against
    // accidentally armed sessions burning Deepgram billing while
    // unattended (armed mode bypasses the VAD gate). Started on the
    // false→true transition; cleared on the true→false transition or
    // session shutdown.
    let armedTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const clearArmedTimeout = () => {
      if (armedTimeoutTimer) {
        clearTimeout(armedTimeoutTimer);
        armedTimeoutTimer = null;
      }
    };

    // Single mutator so every armed-state transition (start, end,
    // scrap, redo, abort) goes through one place that also announces
    // the change to the client. No-op if state is unchanged.
    const setArmed = (next: boolean) => {
      if (keywordArmed === next) return;
      keywordArmed = next;
      diagLog("keyword armed state", { armed: next });
      publishVoiceState({ armed: next });
      if (next) {
        const seconds = activeKeywords.maxArmedSeconds;
        if (seconds && seconds > 0) {
          armedTimeoutTimer = setTimeout(() => {
            armedTimeoutTimer = null;
            // Re-check armed state in case a race with another
            // disarm path beat us here. setArmed is idempotent
            // anyway, but skip the side effects.
            if (!keywordArmed) return;
            diagLog("keyword armed timeout", { seconds });
            performAction("scrap", "timeout");
          }, seconds * 1000);
        }
      } else {
        clearArmedTimeout();
      }
    };

    // Common helper: clear the framework's transcript buffer by
    // committing the user turn while flagging the resulting llmNode
    // call to drop the message instead of forwarding to Pi.
    const commitAndDrop = (note: string, payload: Record<string, unknown>) => {
      diagLog(note, payload);
      agent.markDropNext();
      try {
        session.commitUserTurn();
      } catch (err) {
        logger.warn({ err }, "[worker] commitUserTurn failed");
      }
    };

    type Action = "start" | "end" | "scrap" | "redo" | "replay" | "abort";
    type ActionSource = "keyword" | "ui" | "timeout";

    /** Apply a keyword-mode action regardless of how it was triggered.
     *  Used by both spoken-keyword detection (with its own dedup +
     *  state checks above) and UI button clicks via the data channel.
     *  Idempotent for state changes — a second "start" while armed
     *  is a no-op, etc. */
    const performAction = (action: Action, source: ActionSource): void => {
      diagLog("action", { action, source, armed: keywordArmed });
      switch (action) {
        case "start": {
          if (keywordArmed) return;
          setArmed(true);
          if (shouldPlay("copy")) playEarcon(session, "copy");
          break;
        }
        case "end": {
          if (!keywordArmed) return;
          setArmed(false);
          if (shouldPlay("over")) playEarcon(session, "over");
          try {
            session.commitUserTurn();
          } catch (err) {
            logger.warn({ err }, "[worker] commitUserTurn failed");
          }
          break;
        }
        case "scrap": {
          if (!keywordArmed) return;
          setArmed(false);
          if (shouldPlay("out")) playEarcon(session, "out");
          commitAndDrop("action scrap", { source });
          break;
        }
        case "redo": {
          if (!keywordArmed) return;
          if (shouldPlay("copy")) playEarcon(session, "copy");
          commitAndDrop("action redo", { source });
          break;
        }
        case "replay": {
          if (keywordArmed) return; // only when idle
          // Commit FIRST so the framework's userTurnCompleted runs
          // its `_currentSpeech.interrupt()` against either nothing
          // (idle) or the previous agent reply (which we want gone
          // anyway since the user explicitly said "say again"). THEN
          // schedule the replay says — by that point they're queued
          // but not yet _currentSpeech, so they survive the interrupt.
          commitAndDrop("action replay", { source });
          const replayed = agent.replayLastResponse();
          if (!replayed) agent.sayFeedback("Nothing to replay yet.");
          break;
        }
        case "abort": {
          setArmed(false);
          commitAndDrop("action abort", { source });
          agent.abortCurrent();
          agent.sayFeedback("Aborted.");
          break;
        }
      }
    };

    // Listen for control messages from the client UI (button clicks
    // in the keyword-mode action bar). They ride the same data-channel
    // topic the worker uses to publish state changes; the client wraps
    // each click in {kind:"control", action:"<name>"}.
    ctx.room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== "voice-bridge") return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg && msg.kind === "control" && typeof msg.action === "string") {
          performAction(msg.action as Action, "ui");
        }
      } catch {
        // ignore malformed payloads
      }
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      logger.info({ transcript: ev.transcript }, "[worker] user");
      const final =
        (ev as { final?: boolean }).final ??
        (ev as { isFinal?: boolean }).isFinal ??
        true;
      diagLog("user transcript", { transcript: ev.transcript, final });

      if (activeTurnMode === "keyword") {
        const transcript = ev.transcript ?? "";
        const threshold = activeKeywords.matchThreshold;

        // Abort: usable in any state, with time-based dedup so STT
        // partials still containing the abort phrase don't fire it
        // repeatedly until the framework clears the transcript.
        if (Date.now() - lastAbortFireAt > 3000) {
          const a = findAnyKeyword(transcript, activeKeywords.abort, threshold);
          if (a) {
            lastAbortFireAt = Date.now();
            diagLog("keyword abort", { matched: a.matched, score: a.score });
            performAction("abort", "keyword");
            return;
          }
        }

        // Scan partials too — Deepgram emits ~150ms partials and we want
        // to react to keywords as soon as they're recognized rather than
        // waiting for the STT final. Order of checks within each branch
        // matters: scrap/redo are recognized only while armed, replay
        // only while idle, so they can't shadow each other.
        if (!keywordArmed) {
          // Idle: replay last response, or arm for a new message.
          const r = findAnyKeyword(transcript, activeKeywords.replay, threshold);
          if (r && Date.now() - lastReplayFireAt > 3000) {
            lastReplayFireAt = Date.now();
            diagLog("keyword replay", { matched: r.matched, score: r.score });
            performAction("replay", "keyword");
            return;
          }
          const m = findAnyKeyword(transcript, activeKeywords.start, threshold);
          if (m) {
            diagLog("keyword start", { matched: m.matched, score: m.score });
            performAction("start", "keyword");
          }
        } else {
          // Armed: scrap (un-arm), redo (re-arm with fresh state), or
          // end (commit normally).
          const scrap = findAnyKeyword(transcript, activeKeywords.scrap, threshold);
          if (scrap) {
            diagLog("keyword scrap", { matched: scrap.matched, score: scrap.score });
            performAction("scrap", "keyword");
            return;
          }
          const redo = findAnyKeyword(transcript, activeKeywords.redo, threshold);
          if (redo) {
            diagLog("keyword redo", { matched: redo.matched, score: redo.score });
            performAction("redo", "keyword");
            return;
          }
          const end = findAnyKeyword(transcript, activeKeywords.end, threshold);
          if (end) {
            diagLog("keyword end", { matched: end.matched, score: end.score });
            performAction("end", "keyword");
          }
        }
        return; // skip the VAD-mode over earcon below
      }

      if (final && shouldPlay("over")) playEarcon(session, "over");
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
