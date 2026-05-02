/**
 * Voice connection lifecycle for the React app.
 *
 * Owns the LiveKit Room handle plus the current target socket. Switching
 * targets first releases the old dispatch so the worker tears down before a
 * new one is created on the server.
 */
import { useCallback, useRef, useState } from "react";
import { api } from "./api.ts";
import { connectVoice, type VoiceHandle } from "./livekit.ts";

export type VoiceState =
  | { kind: "idle" }
  | { kind: "connecting"; socketPath: string }
  | { kind: "connected"; socketPath: string }
  | { kind: "error"; socketPath: string; message: string };

export function useVoice() {
  const [state, setState] = useState<VoiceState>({ kind: "idle" });
  const [log, setLog] = useState<string[]>([]);
  const handleRef = useRef<VoiceHandle | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-99), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const connect = useCallback(
    async (socketPath: string) => {
      append(`select ${socketPath}`);
      setState({ kind: "connecting", socketPath });
      try {
        // Tear down old handle locally before the server replaces the dispatch.
        if (handleRef.current) {
          await handleRef.current.disconnect();
          handleRef.current = null;
        }
        const dispatch = await api.selectSession(socketPath);
        append(`room=${dispatch.roomName}`);
        const handle = await connectVoice(dispatch, append);
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
    append("disconnected");
  }, [append]);

  return { state, log, connect, disconnect };
}
