/**
 * Three short PCM tones that act as radio-etiquette markers in the voice
 * pipeline:
 *
 *   over — short rising blip, played on user-end-of-turn (STT final transcript)
 *   copy — two-tone ack, played at start of agent's spoken response
 *   out  — short falling blip, played on agent-end-of-turn
 *
 * Generated programmatically (sine + fade-in/out envelope) so we don't ship
 * binary assets. 24 kHz mono, signed 16-bit — matches LiveKit's expected
 * AudioFrame shape and the TTS providers' default output.
 *
 * Played server-side via `AgentSession.say(text, { audio })` so the bytes
 * travel through the agent's audio track and the browser's WebRTC
 * AcousticEchoCanceller treats them as remote audio (no false barge-in).
 */
import { AudioFrame } from "@livekit/rtc-node";
import type { voice } from "@livekit/agents";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BASE_VOLUME = 0.35;

let volumeMultiplier = 1;

export function setEarconVolume(mult: number) {
  const clamped = Math.max(0, Math.min(1, mult));
  if (clamped === volumeMultiplier) return;
  volumeMultiplier = clamped;
  rebuild();
}

function effectiveVolume(): number {
  return BASE_VOLUME * volumeMultiplier;
}

export type EarconKind = "over" | "copy" | "out" | "connect";

function tone(freqHz: number, durationMs: number, fadeMs = 6): Int16Array {
  const samples = Math.max(1, Math.floor((durationMs / 1000) * SAMPLE_RATE));
  const fadeSamples = Math.max(1, Math.floor((fadeMs / 1000) * SAMPLE_RATE));
  const out = new Int16Array(samples);
  const volume = effectiveVolume();
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    let env = 1;
    if (i < fadeSamples) env = i / fadeSamples;
    else if (i > samples - fadeSamples) env = (samples - i) / fadeSamples;
    const v = Math.sin(2 * Math.PI * freqHz * t) * env * volume;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

function concat(...arrs: Int16Array[]): Int16Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

let EARCONS: Record<EarconKind, Int16Array> = build();

function build(): Record<EarconKind, Int16Array> {
  return {
    over: tone(900, 80),
    copy: concat(tone(620, 55), tone(880, 55)),
    out: tone(540, 80),
    // Three-note ascending arpeggio — distinctive "voice ready" cue,
    // played once when the worker connects to a Pi session.
    connect: concat(tone(523, 70), tone(659, 70), tone(784, 110)),
  };
}

function rebuild() {
  EARCONS = build();
}

/**
 * Fire-and-forget. Returns synchronously after handing the AudioFrame off to
 * the AgentSession. If the session's audio output is busy, the speech-handle
 * machinery queues this clip after the current speech.
 */
export function playEarcon(
  session: voice.AgentSession | null | undefined,
  kind: EarconKind,
): void {
  if (!session) return;
  const data = EARCONS[kind];
  if (!data || data.length === 0) return;

  const frame = new AudioFrame(data, SAMPLE_RATE, CHANNELS, data.length);

  const audioStream = new ReadableStream<AudioFrame>({
    start(controller) {
      controller.enqueue(frame);
      controller.close();
    },
  });
  const emptyText = new ReadableStream<string>({
    start(controller) {
      controller.close();
    },
  });

  try {
    session.say(emptyText, {
      audio: audioStream,
      addToChatCtx: false,
      allowInterruptions: false,
    });
  } catch (err) {
    // Best-effort: don't fail the agent turn if earcon playback fails.
    console.error(`[earcon:${kind}] play failed:`, err);
  }
}
