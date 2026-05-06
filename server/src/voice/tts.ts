/**
 * Thin REST clients for the configured TTS providers, used by the
 * /api/test/tts endpoint. Same rationale as stt.ts — direct fetch
 * keeps the server free of the worker's plugin SDKs.
 */

import type { TtsConfig } from "../livekit.ts";

export async function synthesize(opts: {
  text: string;
  config: TtsConfig;
}): Promise<{ audio: Uint8Array; contentType: string; provider: string }> {
  if (opts.config.provider === "openai") return synthesizeOpenAI(opts);
  if (opts.config.provider === "cartesia") return synthesizeCartesia(opts);
  return synthesizeElevenLabs(opts);
}

async function synthesizeElevenLabs(opts: {
  text: string;
  config: TtsConfig;
}): Promise<{ audio: Uint8Array; contentType: string; provider: string }> {
  const apiKey = process.env.ELEVEN_API_KEY ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVEN_API_KEY / ELEVENLABS_API_KEY env var not set");
  }
  const voiceId = opts.config.voiceId || "CwhRBWXzGAHq8TQ4Fs17";
  const model = opts.config.model || "eleven_flash_v2_5";
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text: opts.text, model_id: model }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${body}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { audio: buf, contentType: "audio/mpeg", provider: "elevenlabs" };
}

async function synthesizeOpenAI(opts: {
  text: string;
  config: TtsConfig;
}): Promise<{ audio: Uint8Array; contentType: string; provider: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY env var not set");
  }
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.config.model || "gpt-4o-mini-tts",
      input: opts.text,
      voice: opts.config.voiceId || "alloy",
      // Accept default response_format = mp3.
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS ${res.status}: ${body}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { audio: buf, contentType: "audio/mpeg", provider: "openai" };
}

async function synthesizeCartesia(opts: {
  text: string;
  config: TtsConfig;
}): Promise<{ audio: Uint8Array; contentType: string; provider: string }> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    throw new Error("CARTESIA_API_KEY env var not set");
  }
  if (!opts.config.voiceId) {
    throw new Error("Cartesia requires a voiceId (UUID). Set one in Settings.");
  }
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Cartesia-Version": "2024-11-13",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: opts.config.model || "sonic-3",
      transcript: opts.text,
      voice: { mode: "id", id: opts.config.voiceId },
      output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cartesia ${res.status}: ${body}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { audio: buf, contentType: "audio/mpeg", provider: "cartesia" };
}
