/**
 * VAD-gated STT wrapper for keyword mode.
 *
 * Wraps an inner streaming STT (Deepgram) and forwards audio to it only
 * during VAD-detected speech windows. While the wrapper is "bypassed"
 * (e.g. once the user is armed in keyword mode), every frame passes
 * straight through.
 *
 * Why this exists: in keyword mode the LiveKit framework streams the
 * mic to STT continuously. Deepgram bills per second of audio sent on
 * the WebSocket (KeepAlive frames don't count), so streaming silence
 * 24/7 racks up cost for no reason. Gating with Silero VAD cuts
 * forwarded audio to roughly the percentage of the day someone is
 * actually talking near the mic — typically 5–30%, vs. ~100% with the
 * built-in energy filter alone.
 *
 * Design:
 *  - Maintain a small ring buffer (preroll) of the most recent frames.
 *    On VAD START_OF_SPEECH, flush it to the inner stream so the
 *    leading phoneme of "Pi" isn't clipped.
 *  - On VAD END_OF_SPEECH, hold the gate open for `hangoverMs` so a
 *    short pause mid-phrase doesn't slice the utterance in two.
 *  - Forward every event the inner stream emits verbatim — to the
 *    framework this looks like a normal STT.
 *
 * The wrapper is provider-agnostic in shape, but only worth using with
 * a streaming, billed-per-audio-second STT (Deepgram). Wrapping the
 * batch OpenAI STT would do nothing useful.
 */
import {
  stt as sttNs,
  VADEventType,
  type VAD,
  type APIConnectOptions,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";

export interface GatedSTTOptions {
  /** The real STT to gate. Must be streaming. */
  inner: sttNs.STT;
  /** Silero VAD instance. Safe to share across streams. */
  vad: VAD;
  /**
   * How much recent audio to retain in the preroll ring buffer, in ms.
   * Flushed to the inner stream on START_OF_SPEECH so leading phonemes
   * survive VAD inference latency. ~300ms is enough for Silero's
   * default minSpeechDuration; bump if leading words are clipped.
   */
  prerollMs?: number;
  /**
   * After VAD reports END_OF_SPEECH, keep the gate open for this long
   * before closing. Bridges short pauses ("Pi… come in") and gives the
   * inner STT room to finalize.
   */
  hangoverMs?: number;
  /**
   * When this returns true, the gate is forced open: every frame goes
   * straight through to the inner STT, VAD events are ignored. Used to
   * bypass gating once a keyword-mode turn is armed, so quiet words
   * mid-command can't be dropped.
   */
  isBypassed?: () => boolean;
  /** Optional diagnostic hook for gate transitions. */
  onDiag?: (msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_PREROLL_MS = 300;
const DEFAULT_HANGOVER_MS = 600;

export class GatedSTT extends sttNs.STT {
  label = "gated.STT";
  #opts: GatedSTTOptions;

  constructor(opts: GatedSTTOptions) {
    super({
      streaming: true,
      interimResults: opts.inner.capabilities.interimResults,
      alignedTranscript: opts.inner.capabilities.alignedTranscript ?? false,
      diarization: opts.inner.capabilities.diarization,
    });
    if (!opts.inner.capabilities.streaming) {
      throw new Error("GatedSTT: inner STT must be streaming");
    }
    this.#opts = opts;
  }

  override get model(): string {
    return this.#opts.inner.model;
  }

  override get provider(): string {
    return `gated:${this.#opts.inner.provider}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async _recognize(): Promise<sttNs.SpeechEvent> {
    throw new Error("recognize() not supported on GatedSTT (streaming-only)");
  }

  override stream(options?: { connOptions?: APIConnectOptions }): GatedSpeechStream {
    return new GatedSpeechStream(this, this.#opts, options?.connOptions);
  }

  override async close(): Promise<void> {
    await this.#opts.inner.close();
  }
}

class GatedSpeechStream extends sttNs.SpeechStream {
  label = "gated.SpeechStream";
  #opts: GatedSTTOptions;

  constructor(parent: GatedSTT, opts: GatedSTTOptions, connOptions?: APIConnectOptions) {
    // Pass undefined sample rate so we don't double-resample — the
    // inner stream resamples to its own needs, and our wrapper just
    // shuttles frames through.
    super(parent, undefined, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const inner = this.#opts.inner.stream({ connOptions: undefined });
    const vadStream = this.#opts.vad.stream();

    const prerollMs = this.#opts.prerollMs ?? DEFAULT_PREROLL_MS;
    const hangoverMs = this.#opts.hangoverMs ?? DEFAULT_HANGOVER_MS;
    const diag = this.#opts.onDiag;

    // Sliding ring buffer of recent frames. While the gate is closed,
    // every frame goes here; on START_OF_SPEECH we flush it to the
    // inner stream so the inner STT sees ~prerollMs of pre-trigger
    // audio and doesn't miss the leading phoneme.
    let preroll: AudioFrame[] = [];
    let prerollDurationMs = 0;

    let gateOpen = false;
    let hangoverTimer: ReturnType<typeof setTimeout> | null = null;

    const trimPreroll = () => {
      while (preroll.length > 0 && prerollDurationMs > prerollMs) {
        const head = preroll.shift()!;
        prerollDurationMs -= frameDurationMs(head);
      }
    };

    const cancelHangover = () => {
      if (hangoverTimer) {
        clearTimeout(hangoverTimer);
        hangoverTimer = null;
      }
    };

    // Forward inner stream events verbatim into our queue. The base
    // class's monitorMetrics() then pushes them out to `output` for
    // the framework to consume.
    const eventForwarder = (async () => {
      try {
        for await (const ev of inner) {
          if (this.queue.closed) break;
          this.queue.put(ev);
        }
      } catch {
        // Inner stream errors are surfaced via inner's STT error event;
        // the wrapper's queue just stops. The base mainTask will retry
        // run() based on connOptions.
      }
    })();

    // Watch VAD for gate transitions.
    const vadWatcher = (async () => {
      try {
        for await (const ev of vadStream) {
          if (ev.type === VADEventType.START_OF_SPEECH) {
            cancelHangover();
            if (!gateOpen) {
              const flushed = preroll.length;
              for (const f of preroll) inner.pushFrame(f);
              preroll = [];
              prerollDurationMs = 0;
              gateOpen = true;
              diag?.("[gate] open", { prerollFrames: flushed });
            }
          } else if (ev.type === VADEventType.END_OF_SPEECH) {
            cancelHangover();
            hangoverTimer = setTimeout(() => {
              gateOpen = false;
              hangoverTimer = null;
              diag?.("[gate] closed");
            }, hangoverMs);
          }
        }
      } catch {
        // VAD stream closing during shutdown is expected.
      }
    })();

    // Drain our input queue, route each frame to VAD + (gate ? inner : preroll).
    try {
      while (!this.input.closed && !this.closed) {
        const r = await this.input.next();
        if (r.done) break;
        const item = r.value;

        if (item === sttNs.SpeechStream.FLUSH_SENTINEL) {
          inner.flush();
          continue;
        }

        const frame = item;

        // Always feed VAD so its state machine stays current.
        vadStream.pushFrame(frame);

        const bypass = this.#opts.isBypassed?.() ?? false;
        if (bypass || gateOpen) {
          inner.pushFrame(frame);
        } else {
          preroll.push(frame);
          prerollDurationMs += frameDurationMs(frame);
          trimPreroll();
        }
      }
    } finally {
      cancelHangover();
      try {
        vadStream.endInput();
      } catch {
        /* already closed */
      }
      try {
        inner.endInput();
      } catch {
        /* already closed */
      }
      // Wait for pending events to drain into the outer queue before
      // letting run() return — base mainTask will close `queue` after.
      await Promise.allSettled([eventForwarder, vadWatcher]);
      vadStream.close();
      inner.close();
    }
  }
}

function frameDurationMs(f: AudioFrame): number {
  return (f.samplesPerChannel / f.sampleRate) * 1000;
}
