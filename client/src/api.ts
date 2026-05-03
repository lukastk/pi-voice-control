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
    turnMode: "vad" | "manual";
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

  elevenLabsVoices: () =>
    jsonFetch<{ ok: boolean; voices: ElevenLabsVoice[]; error?: string }>(
      "/api/voices/elevenlabs",
    ),
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
