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
    };
    tts: {
      provider: "elevenlabs" | "openai" | "cartesia";
      model: string;       // elevenlabs: "eleven_flash_v2_5"; openai: "tts-1"/"gpt-4o-mini-tts"; cartesia: "sonic-3"
      voiceId: string;     // provider-specific voice id
    };
    turnMode: "vad" | "manual" | "keyword";
    keywords: {
      // Spoken phrases that bracket each user turn in keyword mode.
      // Matched case-insensitively against STT partial+final transcripts.
      // Stripped from the message before it's sent to Pi. Each side
      // accepts multiple alternatives — the first one to match wins,
      // useful for catching STT mishearings ("Pi" → "Pie" / "high").
      start: string[];
      end: string[];
      // Fuzzy-match similarity threshold in [0..1]. 1.0 = exact match;
      // ~0.75 lets common STT mishearings match (e.g. "high come in" ≈
      // "pi come in"). Lower = more permissive but more false triggers.
      matchThreshold: number;
    };
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
      matchThreshold: 0.75,
    },
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

/** Coerce schema drift from older config files. Today: keywords.start
 *  / keywords.end were single strings; now they're string arrays.
 *  Wrap a leftover string into a single-element array. */
function normalize(cfg: Config): Config {
  const k = cfg.voice.keywords as { start: unknown; end: unknown; matchThreshold: number };
  if (typeof k.start === "string") k.start = [k.start];
  if (typeof k.end === "string") k.end = [k.end];
  if (!Array.isArray(k.start)) k.start = [...DEFAULTS.voice.keywords.start];
  if (!Array.isArray(k.end)) k.end = [...DEFAULTS.voice.keywords.end];
  k.start = (k.start as string[]).map((s) => String(s).trim()).filter(Boolean);
  k.end = (k.end as string[]).map((s) => String(s).trim()).filter(Boolean);
  if ((k.start as string[]).length === 0) k.start = [...DEFAULTS.voice.keywords.start];
  if ((k.end as string[]).length === 0) k.end = [...DEFAULTS.voice.keywords.end];
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
