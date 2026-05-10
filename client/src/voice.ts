/**
 * Voice connection lifecycle for the React app.
 *
 * Owns the VoiceTransport (WebTransport via livekit-client, or
 * NativeTransport via the Android wrapper's JS↔Kotlin bridge — see
 * voice-transport.ts) plus the current target socket. Switching targets
 * first releases the old dispatch so the worker tears down before a new
 * one is created on the server.
 */
import { useCallback, useRef, useState } from "react";
import { api } from "./api.ts";
import type { VoiceTransport } from "./voice-transport.ts";
import { WebTransport } from "./web-transport.ts";
import { NativeTransport } from "./native-transport.ts";

export type Toast = { id: number; kind: "error" | "info"; source?: string; message: string };

export type VoiceState =
  | { kind: "idle" }
  | { kind: "connecting"; socketPath: string }
  | { kind: "connected"; socketPath: string }
  | { kind: "error"; socketPath: string; message: string };

type ConnectOptions = {
  /** "manual" mode starts with mic muted; "vad" and "keyword" leave it open. */
  turnMode: "vad" | "manual" | "keyword";
  /** Master mic toggle. When false, mic stays muted regardless of mode. */
  micEnabled: boolean;
  /** Specific input device. null = browser/OS default. Web-transport only. */
  micDeviceId: string | null;
  /** AudioDeviceInfo.id for the Android wrapper. null = OS default.
   *  Native-transport only. Stored separately from micDeviceId so the
   *  same config can drive both platforms without one stomping the other. */
  androidMicDeviceId: string | null;
};

/**
 * Pick a transport based on the runtime environment. The Android wrapper
 * exposes window.AndroidVoiceBridge; everything else (browser, iOS, PWA)
 * falls through to the LiveKit Web SDK. Selection is one-time per
 * useVoice() session — we never switch transports mid-session.
 */
function pickTransport(): VoiceTransport {
  if (typeof window !== "undefined" && window.AndroidVoiceBridge) {
    console.log("[voice] using NativeTransport (Android wrapper)");
    return new NativeTransport();
  }
  console.log("[voice] using WebTransport (LiveKit Web SDK)");
  return new WebTransport();
}

export function useVoice() {
  const [state, setState] = useState<VoiceState>({ kind: "idle" });
  const [log, setLog] = useState<string[]>([]);
  const [micMuted, setMicMutedState] = useState<boolean>(false);
  // Mirrors the worker's keyword-mode armed state, pushed over the
  // LiveKit data channel as {kind:"voice-state", armed: bool}. Always
  // false outside keyword mode and outside an active session.
  const [armed, setArmed] = useState<boolean>(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const transportRef = useRef<VoiceTransport | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-99), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const pushToast = useCallback(
    (kind: "error" | "info", source: string | undefined, message: string) => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev, { id, kind, source, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 8000);
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * Subscribe React state to the transport's event stream. Listeners are
   * scoped to the transport instance, which is dropped on disconnect, so
   * we don't bother tracking unsubscribe handles here — when the transport
   * goes out of scope the Map of listeners goes with it.
   */
  const wireTransport = useCallback(
    (transport: VoiceTransport) => {
      transport.on("connected", () => append("connected"));
      transport.on("disconnected", (ev) => {
        append(`disconnected: ${ev.reason}`);
        // Mid-session disconnect (server kick / network loss). User-
        // initiated disconnects come through the same path with reason="user"
        // and the toast suppression below keeps that case quiet.
        if (ev.reason !== "user") {
          pushToast(
            "error",
            "WebRTC",
            `Voice link dropped (${ev.reason}). Reconnect from Sessions tab.`,
          );
        }
      });
      transport.on("reconnecting", () => {
        append("reconnecting…");
        pushToast("info", "WebRTC", "Voice link reconnecting…");
      });
      transport.on("reconnected", () => {
        append("reconnected");
        pushToast("info", "WebRTC", "Voice link restored.");
      });
      transport.on("data", (ev) => {
        const msg = ev.message;
        // voice-state messages: today just the keyword-mode armed flag.
        if (msg && msg.kind === "voice-state") {
          if (typeof msg.armed === "boolean") setArmed(msg.armed);
          return;
        }
        // Toast-eligible kinds the worker publishes:
        // {kind, source?, message}.
        if (
          msg &&
          (msg.kind === "error" || msg.kind === "info") &&
          typeof msg.message === "string"
        ) {
          pushToast(msg.kind, msg.source, msg.message);
        }
      });
      transport.on("error", (ev) => {
        append(`error: ${ev.source}: ${ev.message}`);
        pushToast("error", ev.source, ev.message);
      });
      transport.on("mic-state", (ev) => {
        setMicMutedState(ev.muted);
      });
    },
    [append, pushToast],
  );

  const connect = useCallback(
    async (socketPath: string, opts: ConnectOptions) => {
      append(`select ${socketPath} (mode=${opts.turnMode}, micEnabled=${opts.micEnabled})`);
      setState({ kind: "connecting", socketPath });
      // Initial mute reflects either PTT-default-muted or the master
      // mic-enabled toggle being off.
      setMicMutedState(opts.turnMode === "manual" || !opts.micEnabled);
      try {
        if (transportRef.current) {
          await transportRef.current.disconnect();
          transportRef.current = null;
        }
        const dispatch = await api.selectSession(socketPath);
        append(`room=${dispatch.roomName}`);
        const transport = pickTransport();
        wireTransport(transport);
        await transport.connect({
          dispatch,
          turnMode: opts.turnMode,
          micEnabled: opts.micEnabled,
          micDeviceId: opts.micDeviceId,
          androidMicDeviceId: opts.androidMicDeviceId,
        });
        transportRef.current = transport;
        setState({ kind: "connected", socketPath });
      } catch (err: any) {
        append(`error: ${err.message}`);
        setState({ kind: "error", socketPath, message: err.message });
      }
    },
    [append, wireTransport],
  );

  const disconnect = useCallback(async () => {
    append("disconnecting");
    if (transportRef.current) {
      await transportRef.current.disconnect();
      transportRef.current = null;
    }
    await api.releaseSession();
    setState({ kind: "idle" });
    setMicMutedState(false);
    setArmed(false);
    append("disconnected");
  }, [append]);

  const toggleMic = useCallback(async () => {
    if (!transportRef.current) return;
    const next = !micMuted;
    await transportRef.current.setMicMuted(next);
    setMicMutedState(next);
    append(next ? "mic muted" : "mic unmuted (talk now)");
  }, [append, micMuted]);

  const setMicMutedExplicit = useCallback(
    async (muted: boolean) => {
      if (!transportRef.current) return;
      if (muted === micMuted) return;
      await transportRef.current.setMicMuted(muted);
      setMicMutedState(muted);
      append(muted ? "mic muted (mode change)" : "mic unmuted (mode change)");
    },
    [append, micMuted],
  );

  const publishControl = useCallback(
    async (action: string) => {
      if (!transportRef.current) return;
      try {
        await transportRef.current.publishControl(action);
        append(`control: ${action}`);
      } catch (err: any) {
        append(`control failed: ${action}: ${err?.message ?? err}`);
      }
    },
    [append],
  );

  return {
    state,
    log,
    connect,
    disconnect,
    micMuted,
    armed,
    toggleMic,
    setMicMutedExplicit,
    publishControl,
    toasts,
    dismissToast,
  };
}
