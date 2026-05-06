/**
 * Thin REST clients for the configured STT providers, used by the
 * /api/test/stt endpoint to let the user try out their pipeline
 * settings without going through a Pi session. We do NOT pull in the
 * full @livekit/agents-plugin-* SDKs here — the worker owns those and
 * the server just wants a one-shot transcribe.
 */

import type { SttConfig } from "../livekit.ts";

export async function transcribe(opts: {
  audio: Uint8Array;
  contentType: string;
  config: SttConfig;
}): Promise<{ transcript: string; provider: string }> {
  if (opts.config.provider === "deepgram") {
    return transcribeDeepgram(opts);
  }
  return transcribeWhisper(opts);
}

async function transcribeDeepgram(opts: {
  audio: Uint8Array;
  contentType: string;
  config: SttConfig;
}): Promise<{ transcript: string; provider: string }> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY env var not set");
  }
  const params = new URLSearchParams({
    model: opts.config.model || "nova-3",
    language: opts.config.language || "en",
    smart_format: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": opts.contentType,
    },
    body: opts.audio as BodyInit,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Deepgram ${res.status}: ${body}`);
  }
  const json = (await res.json()) as any;
  const transcript: string = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return { transcript, provider: "deepgram" };
}

async function transcribeWhisper(opts: {
  audio: Uint8Array;
  contentType: string;
  config: SttConfig;
}): Promise<{ transcript: string; provider: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY env var not set");
  }
  // Whisper requires multipart/form-data with a `file` field. The
  // filename's extension matters — Whisper sniffs format from it. We
  // pick a safe-ish .webm default since the browser MediaRecorder
  // typically produces WebM/Opus. If the client sent a different
  // content-type we honor that for the extension hint.
  const ext = inferExtensionFromContentType(opts.contentType);
  const blob = new Blob([opts.audio.buffer as ArrayBuffer], { type: opts.contentType });
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", opts.config.model || "whisper-1");
  if (opts.config.language) form.append("language", opts.config.language);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI Whisper ${res.status}: ${body}`);
  }
  const json = (await res.json()) as any;
  return { transcript: typeof json?.text === "string" ? json.text : "", provider: "openai-whisper" };
}

function inferExtensionFromContentType(ct: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes("webm")) return "webm";
  if (lower.includes("mp4")) return "mp4";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  return "webm";
}
