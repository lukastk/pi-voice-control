// Provider catalogues for STT and TTS.
//
// Mirrors the literal-union types shipped by each @livekit/agents-plugin-X
// (see node_modules/.bun/@livekit+agents-plugin-X/dist/models.d.ts). When a
// provider exposes a small fixed enum we drive a dropdown from these lists;
// when a provider has a user-creatable / unbounded catalogue (ElevenLabs
// voices, Cartesia voices) we keep the field as a free-form text input.

// ---- STT ----

export const STT_MODELS = {
  "openai-whisper": ["whisper-1"],
  deepgram: [
    "nova-3",
    "nova-3-general",
    "nova-3-medical",
    "nova-2-general",
    "nova-2-meeting",
    "nova-2-phonecall",
    "nova-2-finance",
    "nova-2-conversationalai",
    "nova-2-medical",
    "nova-general",
    "enhanced-general",
    "base",
    "whisper-large",
  ],
} as const;

export const STT_LANGUAGES = ["en", "de", "fr", "es", "it", "ja", "zh", "pt", "ru", "ko", "multi"] as const;

// ---- TTS ----

export const TTS_MODELS = {
  elevenlabs: [
    "eleven_flash_v2_5",
    "eleven_flash_v2",
    "eleven_turbo_v2_5",
    "eleven_turbo_v2",
    "eleven_multilingual_v2",
    "eleven_multilingual_v1",
    "eleven_v3",
    "eleven_monolingual_v1",
  ],
  openai: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
  cartesia: ["sonic-3", "sonic-2", "sonic-turbo", "sonic", "sonic-lite", "sonic-preview"],
} as const;

// OpenAI ships a fixed voice catalogue (TTSVoices in @livekit/agents-plugin-openai).
export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;

// ---- defaults ----

export const TTS_DEFAULT_MODEL: Record<"elevenlabs" | "openai" | "cartesia", string> = {
  elevenlabs: "eleven_flash_v2_5",
  openai: "gpt-4o-mini-tts",
  cartesia: "sonic-3",
};

export const TTS_DEFAULT_VOICE: Record<"elevenlabs" | "openai" | "cartesia", string> = {
  elevenlabs: "CwhRBWXzGAHq8TQ4Fs17",
  openai: "alloy",
  cartesia: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
};

export const STT_DEFAULT_MODEL: Record<"openai-whisper" | "deepgram", string> = {
  "openai-whisper": "whisper-1",
  deepgram: "nova-3",
};
