/**
 * JSON config persisted at ~/.config/voice-agent-bridge/config.json.
 *
 * Phase 2 schema only covers fields we actually read. STT/TTS/voice/keys
 * arrive in Phase 6 when the Settings tab grows.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export type Config = {
  tmux: {
    socketName: string; // -L <name> for the user's main tmux server
  };
  pi: {
    socketsDir: string;
    pollIntervalMs: number;
    staleSocketAfterMs: number;
  };
  startup: {
    defaultFolder: string | null;
    spawnIfMissing: boolean;
    spawnTmuxSession: string;
  };
  prompt: {
    filePath: string; // tilde expanded at read-time
    clearOnSwitch: boolean;
  };
  voice: {
    earcons: {
      enabled: boolean;
      over: boolean;
      copy: boolean;
      out: boolean;
      volume: number;
    };
    stt: {
      provider: "openai-whisper" | "deepgram";
      model: string;       // openai: "whisper-1"; deepgram: "nova-3" / "nova-2-general"
      language: string;    // ISO code, e.g. "en"
      // Custom vocabulary — proper nouns, project names, jargon that
      // generic STT mis-renders ("boxyard" → "box yard"). One entry
      // per term/phrase. Forwarded as Deepgram keyterm+keywords or
      // Whisper prompt.
      vocabulary: string[];
    };
    tts: {
      provider: "elevenlabs" | "openai" | "cartesia";
      model: string;       // elevenlabs: "eleven_flash_v2_5"; openai: "tts-1"/"gpt-4o-mini-tts"; cartesia: "sonic-3"
      voiceId: string;     // provider-specific voice id
    };
    turnMode: "vad" | "manual" | "keyword";
    keywords: {
      // Spoken phrases that drive each user turn in keyword mode.
      // Matched case-insensitively against STT partial+final transcripts.
      // Each slot accepts multiple alternatives (first match wins) to
      // catch STT mishearings. The matched phrase is stripped from any
      // message that does reach Pi.
      //
      //   start  — begin a new message (sets armed state)
      //   end    — commit the current message (sends to Pi)
      //   scrap  — discard the current message, return to idle
      //   redo   — discard the current message, restart armed
      //   replay — re-speak the last agent response (only while idle)
      //   abort  — tell Pi to stop whatever it's doing (escape-key
      //            equivalent). Recognized in any state; cancels the
      //            in-flight pi.prompt and stops the agent from
      //            speaking further chunks of its current reply.
      start: string[];
      end: string[];
      scrap: string[];
      redo: string[];
      replay: string[];
      abort: string[];
      // Fuzzy-match similarity threshold in [0..1]. 1.0 = exact match;
      // ~0.75 lets common STT mishearings match (e.g. "high come in" ≈
      // "pi come in"). Lower = more permissive but more false triggers.
      matchThreshold: number;
      // Safety net: if a keyword turn stays armed this long without
      // an end / scrap / redo / abort, auto-scrap it. Guards against
      // accidentally armed sessions racking up Deepgram billing while
      // unattended (armed mode bypasses the VAD gate). 0 = disabled.
      maxArmedSeconds: number;
    };
    // VAD-gated STT for keyword mode. While disarmed (waiting for the
    // start phrase), audio is only forwarded to the cloud STT during
    // VAD-detected speech windows — Deepgram bills per second of
    // streamed audio, so silence costs nothing. Only takes effect when
    // turnMode === "keyword" and stt.provider === "deepgram".
    keywordGating: {
      enabled: boolean;
      // Ring-buffer length flushed to STT on START_OF_SPEECH. Recovers
      // the leading phoneme that VAD's inference window misses. ~300ms
      // is enough for Silero defaults; bump if "Pi" gets clipped.
      prerollMs: number;
      // After VAD reports end-of-speech, keep the gate open for this
      // long. Bridges short pauses inside an utterance ("Pi… come in").
      hangoverMs: number;
      // Silero VAD knobs (passed to silero.VAD.updateOptions). All
      // optional; defaults are Silero's own defaults.
      activationThreshold: number;     // 0..1, default 0.5
      minSpeechDurationMs: number;     // default 50
      minSilenceDurationMs: number;    // default 550
      prefixPaddingMs: number;         // Silero's own pre-trigger pad, default 500
    };
    // Master mic toggle, orthogonal to turnMode. When false, the mic
    // stays muted regardless of mode (no STT, no agent attention) —
    // useful for short privacy windows without losing your VAD/KW
    // settings. Toggle from the top-bar mic button.
    micEnabled: boolean;
    // Specific microphone device to capture from. null = browser
    // default. Populated by the Settings tab from
    // navigator.mediaDevices.enumerateDevices(). Web-transport only —
    // the Android wrapper has its own field below.
    micDeviceId: string | null;
    // Android-only counterpart to micDeviceId. The string is the
    // AudioDeviceInfo.id (stringified int) returned by
    // AudioManager.getDevices(GET_DEVICES_INPUTS) on the device.
    // Applied via JavaAudioDeviceModule.setPreferredInputDevice after
    // the Room connects. null = let LiveKit/the OS pick.
    androidMicDeviceId: string | null;
  };
};

export const DEFAULTS: Config = {
  tmux: { socketName: "mysystem" },
  pi: {
    socketsDir: "/tmp/pi-rpc-sockets",
    pollIntervalMs: 2000,
    staleSocketAfterMs: 30000,
  },
  startup: {
    defaultFolder: null,
    spawnIfMissing: true,
    spawnTmuxSession: "voice-bridge-pi",
  },
  prompt: {
    filePath: "~/.pi/agent/AGENTS.voice.md",
    clearOnSwitch: false,
  },
  voice: {
    earcons: {
      enabled: true,
      over: true,
      copy: false,
      out: true,
      volume: 1,
    },
    stt: {
      provider: "openai-whisper",
      model: "whisper-1",
      language: "en",
      vocabulary: [],
    },
    tts: {
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      voiceId: "CwhRBWXzGAHq8TQ4Fs17",
    },
    turnMode: "vad",
    keywords: {
      start: ["Pi, come in"],
      end: ["Pi, that's all"],
      scrap: ["Pi, scrap that"],
      redo: ["Pi, do over"],
      replay: ["Pi, say again"],
      abort: ["Pi, abort"],
      matchThreshold: 0.75,
      maxArmedSeconds: 60,
    },
    keywordGating: {
      enabled: true,
      prerollMs: 300,
      hangoverMs: 600,
      activationThreshold: 0.5,
      minSpeechDurationMs: 50,
      minSilenceDurationMs: 550,
      prefixPaddingMs: 500,
    },
    micEnabled: true,
    micDeviceId: null,
    androidMicDeviceId: null,
  },
};

const CONFIG_DIR = join(homedir(), ".config", "voice-agent-bridge");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let cached: Config | null = null;

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): Config {
  if (cached) return cached;
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf8");
    cached = structuredClone(DEFAULTS);
    return cached;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    cached = normalize(mergeDefaults(parsed));
    return cached;
  } catch (err) {
    console.error(`[config] failed to read ${CONFIG_PATH}:`, err);
    cached = structuredClone(DEFAULTS);
    return cached;
  }
}

/** Coerce schema drift from older config files. keywords slots were
 *  added incrementally (start/end → +scrap/redo/replay) and started as
 *  single strings before becoming arrays. Wrap leftover strings, fill
 *  missing slots from defaults, drop empty entries. */
function normalize(cfg: Config): Config {
  const k = cfg.voice.keywords as Record<string, unknown>;
  const slots: Array<keyof Config["voice"]["keywords"]> = [
    "start",
    "end",
    "scrap",
    "redo",
    "replay",
    "abort",
  ];
  for (const slot of slots) {
    let v = k[slot];
    if (typeof v === "string") v = [v];
    if (!Array.isArray(v)) v = [...(DEFAULTS.voice.keywords[slot] as string[])];
    v = (v as unknown[]).map((s) => String(s).trim()).filter(Boolean);
    if ((v as string[]).length === 0) v = [...(DEFAULTS.voice.keywords[slot] as string[])];
    k[slot] = v;
  }
  // STT vocabulary: array of trimmed non-empty strings; empty list is
  // valid (means "no custom vocab"), distinct from the keyword slots
  // above which fall back to defaults when emptied.
  const stt = cfg.voice.stt as Record<string, unknown>;
  let vocab = stt.vocabulary;
  if (typeof vocab === "string") vocab = [vocab];
  if (!Array.isArray(vocab)) vocab = [];
  vocab = (vocab as unknown[]).map((s) => String(s).trim()).filter(Boolean);
  stt.vocabulary = vocab;
  return cfg;
}

export function getConfig(): Config {
  return loadConfig();
}

export function updateConfig(patch: DeepPartial<Config>): Config {
  const current = loadConfig();
  const next = normalize(deepMerge(current, patch) as Config);
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  cached = next;
  return next;
}

// --- helpers ---

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function mergeDefaults(partial: Partial<Config>): Config {
  return deepMerge(structuredClone(DEFAULTS), partial) as Config;
}

function deepMerge<T extends Record<string, any>>(
  base: T,
  patch: Record<string, any> | undefined,
): T {
  if (!patch) return base;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
