/**
 * Voice connection lifecycle for the React app.
 *
 * Owns the LiveKit Room handle plus the current target socket. Switching
 * targets first releases the old dispatch so the worker tears down before a
 * new one is created on the server.
 */
import { useCallback, useRef, useState } from "react";
import { api } from "./api.ts";
import { connectVoice, setMicMuted, type VoiceHandle } from "./livekit.ts";

// re-export for convenience in App when wiring connect()
export type { VoiceHandle };

export type VoiceState =
  | { kind: "idle" }
  | { kind: "connecting"; socketPath: string }
  | { kind: "connected"; socketPath: string }
  | { kind: "error"; socketPath: string; message: string };

type ConnectOptions = {
  /** "manual" mode starts with mic muted; "vad" lets it stay open. */
  turnMode: "vad" | "manual";
};

export function useVoice() {
  const [state, setState] = useState<VoiceState>({ kind: "idle" });
  const [log, setLog] = useState<string[]>([]);
  const [micMuted, setMicMutedState] = useState<boolean>(false);
  const handleRef = useRef<VoiceHandle | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-99), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const connect = useCallback(
    async (socketPath: string, opts: ConnectOptions) => {
      append(`select ${socketPath} (mode=${opts.turnMode})`);
      setState({ kind: "connecting", socketPath });
      const startMicEnabled = opts.turnMode === "vad";
      setMicMutedState(!startMicEnabled);
      try {
        if (handleRef.current) {
          await handleRef.current.disconnect();
          handleRef.current = null;
        }
        const dispatch = await api.selectSession(socketPath);
        append(`room=${dispatch.roomName}`);
        const handle = await connectVoice(dispatch, append, { startMicEnabled });
        handleRef.current = handle;
        setState({ kind: "connected", socketPath });
      } catch (err: any) {
        append(`error: ${err.message}`);
        setState({ kind: "error", socketPath, message: err.message });
      }
    },
    [append],
  );

  const disconnect = useCallback(async () => {
    append("disconnecting");
    if (handleRef.current) {
      await handleRef.current.disconnect();
      handleRef.current = null;
    }
    await api.releaseSession();
    setState({ kind: "idle" });
    setMicMutedState(false);
    append("disconnected");
  }, [append]);

  const toggleMic = useCallback(async () => {
    if (!handleRef.current) return;
    const next = !micMuted;
    await setMicMuted(handleRef.current, next);
    setMicMutedState(next);
    append(next ? "mic muted" : "mic unmuted (talk now)");
  }, [append, micMuted]);

  const setMicMutedExplicit = useCallback(
    async (muted: boolean) => {
      if (!handleRef.current) return;
      if (muted === micMuted) return;
      await setMicMuted(handleRef.current, muted);
      setMicMutedState(muted);
      append(muted ? "mic muted (mode change)" : "mic unmuted (mode change)");
    },
    [append, micMuted],
  );

  return { state, log, connect, disconnect, micMuted, toggleMic, setMicMutedExplicit };
}
