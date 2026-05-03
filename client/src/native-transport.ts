/**
 * NativeTransport — drives a native LiveKit Android Room via the
 * window.AndroidVoiceBridge JS↔Kotlin interface. Used inside the Voice
 * Agent Bridge Android wrapper.
 *
 * The wrapper's WebView can't keep audio alive when the screen turns off
 * (Chromium hardcodes USAGE_MEDIA + STREAM_MUSIC; see PLAN-NATIVE-AUDIO.md
 * §2). The native SDK plays audio through STREAM_VOICE_CALL with
 * MODE_IN_COMMUNICATION which Android keeps alive across screen-off —
 * same audio session pattern ChatGPT, Discord, Zoom use.
 */
import type { DispatchResult } from "./api.ts";
import {
  rewriteLocalhost,
  VoiceEventEmitter,
  type VoiceEvent,
  type VoiceTransport,
} from "./voice-transport.ts";

type AndroidVoiceBridge = {
  connect(
    url: string,
    token: string,
    roomName: string,
    identity: string,
    manualMode: boolean,
  ): boolean;
  disconnect(): void;
  setMicMuted(muted: boolean): void;
  getStateJson(): string;
};

type NativeEnvelope = { type: VoiceEvent["type"]; payload: any };

declare global {
  interface Window {
    AndroidVoiceBridge?: AndroidVoiceBridge;
    __voiceBridge?: { dispatch: (env: NativeEnvelope) => void };
  }
}

export class NativeTransport extends VoiceEventEmitter implements VoiceTransport {
  constructor() {
    super();
    // Install (or replace) the global dispatch handler the Kotlin bridge
    // calls into via webView.evaluateJavascript("window.__voiceBridge && window.__voiceBridge.dispatch(...)").
    // Last-constructed wins; the previous instance stops receiving events.
    // Our app holds at most one NativeTransport at a time (one per
    // useVoice() session).
    window.__voiceBridge = { dispatch: (env) => this.handleNative(env) };
  }

  async connect({
    dispatch,
    turnMode,
  }: {
    dispatch: DispatchResult;
    turnMode: "vad" | "manual";
  }): Promise<void> {
    const bridge = window.AndroidVoiceBridge;
    if (!bridge) {
      throw new Error("AndroidVoiceBridge missing — wrong transport selected?");
    }

    // The native side has no JS-side context for window.location.hostname,
    // so the ws://localhost rewrite has to happen here before we cross.
    const url = rewriteLocalhost(dispatch.livekitUrl);

    const accepted = bridge.connect(
      url,
      dispatch.token,
      dispatch.roomName,
      "user",
      turnMode === "manual",
    );
    if (!accepted) {
      throw new Error("native bridge rejected connect");
    }

    return new Promise<void>((resolve, reject) => {
      const offConnected = this.on("connected", () => {
        cleanup();
        resolve();
      });
      const offError = this.on("error", (ev) => {
        cleanup();
        reject(new Error(`${ev.source}: ${ev.message}`));
      });
      const offDisconnected = this.on("disconnected", (ev) => {
        // Disconnected during connect means the SDK handshake failed
        // before we ever reached "connected".
        cleanup();
        reject(new Error(`disconnected during connect: ${ev.reason}`));
      });
      function cleanup() {
        offConnected();
        offError();
        offDisconnected();
      }
    });
  }

  async disconnect(): Promise<void> {
    window.AndroidVoiceBridge?.disconnect();
    // The bridge fires "disconnected" asynchronously; voice.ts's listener
    // updates React state when it arrives. We don't await it — disconnect
    // is best-effort.
  }

  async setMicMuted(muted: boolean): Promise<void> {
    window.AndroidVoiceBridge?.setMicMuted(muted);
    // Bridge fires "mic-state"; voice.ts listener updates React state.
  }

  private handleNative(env: NativeEnvelope): void {
    switch (env.type) {
      case "connected":
        this.emit({ type: "connected", roomName: env.payload.roomName });
        break;
      case "disconnected":
        this.emit({ type: "disconnected", reason: env.payload.reason });
        break;
      case "reconnecting":
        this.emit({ type: "reconnecting" });
        break;
      case "reconnected":
        this.emit({ type: "reconnected" });
        break;
      case "data":
        this.emit({
          type: "data",
          topic: env.payload.topic,
          message: env.payload.message,
        });
        break;
      case "error":
        this.emit({
          type: "error",
          source: env.payload.source,
          message: env.payload.message,
        });
        break;
      case "mic-state":
        this.emit({ type: "mic-state", muted: env.payload.muted });
        break;
      default:
        console.warn("[NativeTransport] unknown event from bridge", env);
    }
  }
}
