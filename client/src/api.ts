import type { PiSession } from "./types.ts";

export type DispatchResult = {
  roomName: string;
  token: string;
  livekitUrl: string;
  dispatchId: string;
};

export type Config = {
  tmux: { socketName: string };
  pi: { socketsDir: string; pollIntervalMs: number; staleSocketAfterMs: number };
  startup: {
    defaultFolder: string | null;
    spawnIfMissing: boolean;
    spawnTmuxSession: string;
  };
  prompt: { filePath: string; clearOnSwitch: boolean };
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
      model: string;
      language: string;
    };
    tts: {
      provider: "elevenlabs" | "openai" | "cartesia";
      model: string;
      voiceId: string;
    };
    turnMode: "vad" | "manual" | "keyword";
    /** Optional in the type so a stale server (pre-keywords schema)
     *  doesn't make the whole config undefined. The new server always
     *  sends it via mergeDefaults; the SettingsTab handles absence. */
    keywords?: {
      start: string[];
      end: string[];
      scrap: string[];
      redo: string[];
      replay: string[];
      abort: string[];
      matchThreshold: number;
    };
    /** VAD-gated STT for keyword mode. Optional so a stale server
     *  pre-gating-schema doesn't blank the whole config. */
    keywordGating?: {
      enabled: boolean;
      prerollMs: number;
      hangoverMs: number;
      activationThreshold: number;
      minSpeechDurationMs: number;
      minSilenceDurationMs: number;
      prefixPaddingMs: number;
    };
    /** Optional in case server is older than the schema. */
    micEnabled?: boolean;
    micDeviceId?: string | null;
  };
};

export type DefaultResolution =
  | { kind: "none" }
  | { kind: "match"; session: PiSession }
  | { kind: "missing"; folder: string }
  | { kind: "spawned"; session: PiSession | null; socketPath: string }
  | { kind: "error"; message: string };

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export type Health = {
  ok: boolean;
  term?: { port: number; pinned: boolean };
};

export const api = {
  health: () => jsonFetch<Health>("/api/health"),

  setPin: (pin: boolean) =>
    jsonFetch<{ ok: boolean; pinned: boolean }>("/api/term/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    }),

  listSessions: () => jsonFetch<PiSession[]>("/api/sessions"),
  refreshSessions: () =>
    jsonFetch<PiSession[]>("/api/sessions/refresh", { method: "POST" }),
  resolveDefault: () => jsonFetch<DefaultResolution>("/api/sessions/default"),
  spawnInFolder: (folder?: string) =>
    jsonFetch<{ ok: boolean; socketPath: string; session: PiSession | null; folder: string }>(
      "/api/sessions/spawn",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(folder ? { folder } : {}),
      },
    ),

  selectSession: (socketPath: string) =>
    jsonFetch<DispatchResult>("/api/sessions/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ socketPath }),
    }),
  releaseSession: () =>
    jsonFetch<{ ok: boolean }>("/api/sessions/release", { method: "POST" }),

  getConfig: () => jsonFetch<Config>("/api/config"),
  putConfig: (patch: any) =>
    jsonFetch<Config>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),

  getPrompt: () => jsonFetch<PromptSnapshot>("/api/prompt"),
  putPrompt: (body: string) =>
    jsonFetch<PromptSnapshot & { injected: { ok: boolean; error?: string } | null }>(
      "/api/prompt",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    ),
  reinjectPrompt: () =>
    jsonFetch<PromptSnapshot & { injected: { ok: boolean; error?: string } }>(
      "/api/prompt/reinject",
      { method: "POST" },
    ),
  resetPrompt: () =>
    jsonFetch<PromptSnapshot & { injected: { ok: boolean; error?: string } | null }>(
      "/api/prompt/reset",
      { method: "POST" },
    ),
  clearPromptOnTarget: () =>
    jsonFetch<{ ok: boolean; error?: string }>("/api/prompt/clear", { method: "POST" }),

  elevenLabsVoices: (opts: { refresh?: boolean } = {}) =>
    jsonFetch<{ ok: boolean; voices: ElevenLabsVoice[]; error?: string }>(
      `/api/voices/elevenlabs${opts.refresh ? "?refresh=1" : ""}`,
    ),

  /** One-shot transcribe via the configured STT provider. The audio
   *  blob's content-type drives the file-format hint sent upstream. */
  testStt: async (
    audio: Blob,
  ): Promise<{ ok: boolean; transcript?: string; provider?: string; error?: string }> => {
    const res = await fetch("/api/test/stt", {
      method: "POST",
      headers: { "Content-Type": audio.type || "audio/webm" },
      body: audio,
    });
    return (await res.json()) as {
      ok: boolean;
      transcript?: string;
      provider?: string;
      error?: string;
    };
  },

  /** One-shot synthesize via the configured TTS provider. Returns the
   *  audio blob ready to feed into an HTMLAudioElement.src. The server
   *  responds with audio/mpeg for any provider. */
  testTts: async (
    text: string,
  ): Promise<
    | { ok: true; audio: Blob; provider: string }
    | { ok: false; error: string }
  > => {
    const res = await fetch("/api/test/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    const audio = await res.blob();
    return { ok: true, audio, provider: res.headers.get("X-Tts-Provider") ?? "" };
  },
};

export type ElevenLabsVoice = {
  voice_id: string;
  name: string;
  category?: string;
};

export type PromptSnapshot = {
  path: string;
  body: string;
  mtime: number;
};
