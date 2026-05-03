/**
 * VoiceTransport — abstract over the two ways the React app can run a
 * LiveKit Room: through the LiveKit Web SDK directly (WebTransport, used
 * in any browser / iOS Safari / "add to home screen" PWA) or through the
 * native LiveKit Android SDK via a JS↔Kotlin bridge (NativeTransport, used
 * inside the Voice Agent Bridge Android wrapper).
 *
 * The wrapper exists because Chromium's WebView audio path can't survive
 * screen-off — see PLAN-NATIVE-AUDIO.md §2 for the dumpsys-backed
 * diagnosis. The native SDK plays audio through STREAM_VOICE_CALL with
 * MODE_IN_COMMUNICATION which Android keeps alive across screen-off.
 *
 * The transport boundary is the single place this divergence lives;
 * everything above it (useVoice, the React UI) is transport-agnostic.
 */
import type { DispatchResult } from "./api.ts";

export type VoiceEvent =
  | { type: "connected"; roomName: string }
  | { type: "disconnected"; reason: string }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "data"; topic: string; message: any }
  | { type: "error"; source: string; message: string }
  | { type: "mic-state"; muted: boolean };

export type VoiceEventHandler<E extends VoiceEvent["type"]> = (
  ev: Extract<VoiceEvent, { type: E }>,
) => void;

export interface VoiceTransport {
  connect(args: {
    dispatch: DispatchResult;
    turnMode: "vad" | "manual";
  }): Promise<void>;
  disconnect(): Promise<void>;
  setMicMuted(muted: boolean): Promise<void>;
  on<E extends VoiceEvent["type"]>(
    type: E,
    handler: VoiceEventHandler<E>,
  ): () => void;
}

/**
 * Tiny typed event-emitter shared by both transports. Handlers are stored
 * per-event-type; on() returns an unsubscribe closure.
 */
export class VoiceEventEmitter {
  private listeners = new Map<VoiceEvent["type"], Set<(ev: any) => void>>();

  on<E extends VoiceEvent["type"]>(
    type: E,
    handler: VoiceEventHandler<E>,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const wrapped = handler as (ev: any) => void;
    set.add(wrapped);
    return () => {
      this.listeners.get(type)?.delete(wrapped);
    };
  }

  protected emit(ev: VoiceEvent): void {
    this.listeners.get(ev.type)?.forEach((h) => h(ev));
  }
}

/**
 * Server hands back ws://localhost:7880 because that's how it knows the
 * LiveKit instance. From a mobile / Tailscale client, "localhost" means
 * the phone itself, not the Mac. Rewrite the hostname to match the page's
 * host so ws://<host>:7880 resolves to the same machine the HTTP server
 * is on. Also upgrade ws:// to wss:// when the page itself is on https —
 * Tailscale Serve / any HTTPS proxy in front of LiveKit only accepts TLS,
 * and a plain ws:// to a TLS-only port silently hangs instead of erroring.
 *
 * Both transports apply this; the native side has no JS-side context for
 * window.location.hostname, so the rewrite happens in JS before crossing
 * the bridge.
 */
export function rewriteLocalhost(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    const u = new URL(url);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") {
      u.hostname = window.location.hostname;
    }
    if (window.location.protocol === "https:" && u.protocol === "ws:") {
      u.protocol = "wss:";
    }
    return u.toString();
  } catch {
    return url;
  }
}
