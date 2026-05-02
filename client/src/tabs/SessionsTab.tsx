import { useState } from "react";
import { selectSession, releaseSession } from "../api.ts";
import { connectVoice, type VoiceHandle, type VoiceState } from "../livekit.ts";

export function SessionsTab() {
  const [socketPath, setSocketPath] = useState<string>("");
  const [state, setState] = useState<VoiceState>("idle");
  const [handle, setHandle] = useState<VoiceHandle | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const append = (line: string) =>
    setLog((prev) => [...prev.slice(-50), `${new Date().toLocaleTimeString()}  ${line}`]);

  async function onConnect() {
    if (!socketPath.trim()) return;
    setState("connecting");
    append(`selecting ${socketPath}…`);
    try {
      const dispatch = await selectSession(socketPath.trim());
      append(`dispatched: room=${dispatch.roomName}`);
      const h = await connectVoice(dispatch, append);
      setHandle(h);
      setState("connected");
    } catch (err: any) {
      append(`error: ${err.message}`);
      setState("error");
    }
  }

  async function onDisconnect() {
    append("disconnecting…");
    if (handle) await handle.disconnect();
    await releaseSession();
    setHandle(null);
    setState("idle");
    append("disconnected");
  }

  return (
    <div className="placeholder" style={{ padding: 20 }}>
      <h2>Sessions (Phase 1 — manual)</h2>
      <p style={{ marginBottom: 12 }}>
        Phase 2 auto-discovers Pi sockets. For now, paste a socket path from{" "}
        <code>ls /tmp/pi-rpc-sockets/</code>.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          type="text"
          value={socketPath}
          placeholder="/tmp/pi-rpc-sockets/<uuid>.sock"
          onChange={(e) => setSocketPath(e.target.value)}
          disabled={state === "connecting" || state === "connected"}
          style={{
            flex: 1,
            minWidth: 260,
            padding: "6px 10px",
            background: "#0d0d1a",
            color: "#e6e6f0",
            border: "1px solid #2a2a40",
            borderRadius: 4,
            fontFamily: "'SF Mono', monospace",
            fontSize: 12,
          }}
        />
        {state !== "connected" ? (
          <button
            onClick={onConnect}
            disabled={state === "connecting" || !socketPath.trim()}
            style={btnStyle(state === "connecting" ? "#444" : "#5a57b3")}
          >
            {state === "connecting" ? "Connecting…" : "Connect voice"}
          </button>
        ) : (
          <button onClick={onDisconnect} style={btnStyle("#a33")}>
            Disconnect
          </button>
        )}
      </div>

      <div
        style={{
          background: "#0d0d1a",
          padding: 10,
          borderRadius: 4,
          fontFamily: "'SF Mono', monospace",
          fontSize: 11,
          maxHeight: 240,
          overflowY: "auto",
          color: "#9090a8",
        }}
      >
        {log.length === 0 ? <div>(no events yet)</div> : log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "6px 16px",
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 13,
  };
}
