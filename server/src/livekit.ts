import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

const WS_URL = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
const API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? "secret";
export const AGENT_NAME = "voice-bridge";

/**
 * Browser uses ws:// or wss://; server-SDK uses http:// or https://.
 * Translate so a single LIVEKIT_URL env covers both sides.
 */
function toHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice("ws://".length);
  return wsUrl;
}

const dispatchClient = new AgentDispatchClient(toHttpUrl(WS_URL), API_KEY, API_SECRET);

export type DispatchResult = {
  roomName: string;
  token: string;
  livekitUrl: string;
  dispatchId: string;
};

export type EarconConfig = {
  enabled: boolean;
  over: boolean;
  copy: boolean;
  out: boolean;
  volume: number;
};

export type SttConfig = {
  provider: "openai-whisper" | "deepgram";
  model: string;
  language: string;
  vocabulary?: string[];
};

export type TtsConfig = {
  provider: "elevenlabs" | "openai" | "cartesia";
  model: string;
  voiceId: string;
};

export type TurnMode = "vad" | "manual" | "keyword";

export type KeywordConfig = {
  start: string[];
  end: string[];
  scrap: string[];
  redo: string[];
  replay: string[];
  abort: string[];
  matchThreshold: number;
  /** Auto-scrap an armed turn after this many seconds. 0 = disabled. */
  maxArmedSeconds: number;
};

export type KeywordGatingConfig = {
  enabled: boolean;
  prerollMs: number;
  hangoverMs: number;
  activationThreshold: number;
  minSpeechDurationMs: number;
  minSilenceDurationMs: number;
  prefixPaddingMs: number;
};

export async function dispatchVoiceAgent(opts: {
  socketPath: string;
  appendSystemPrompt?: string;
  identity?: string;
  earcons?: EarconConfig;
  stt?: SttConfig;
  tts?: TtsConfig;
  turnMode?: TurnMode;
  keywords?: KeywordConfig;
  keywordGating?: KeywordGatingConfig;
  interruptOnTurnStart?: boolean;
}): Promise<DispatchResult> {
  const roomName = `voice-${cryptoRandomShort()}`;
  const identity = opts.identity ?? "user";

  const dispatch = await dispatchClient.createDispatch(roomName, AGENT_NAME, {
    metadata: JSON.stringify({
      socketPath: opts.socketPath,
      appendSystemPrompt: opts.appendSystemPrompt,
      earcons: opts.earcons,
      stt: opts.stt,
      tts: opts.tts,
      turnMode: opts.turnMode,
      keywords: opts.keywords,
      keywordGating: opts.keywordGating,
      interruptOnTurnStart: opts.interruptOnTurnStart,
    }),
  });

  const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: "2h" });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  const token = await at.toJwt();

  return {
    roomName,
    token,
    livekitUrl: WS_URL,
    dispatchId: dispatch.id,
  };
}

export async function deleteDispatch(roomName: string, dispatchId: string): Promise<void> {
  try {
    await dispatchClient.deleteDispatch(dispatchId, roomName);
  } catch (err) {
    // Best effort: room may already be empty or the dispatch already torn down.
    console.error("[livekit] deleteDispatch failed (non-fatal):", err);
  }
}

function cryptoRandomShort(): string {
  return crypto.randomUUID().slice(0, 8);
}
