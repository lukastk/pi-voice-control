import { useMemo, useState } from "react";
import { api } from "../api.ts";

type Props = {
  termPort: number;
  termPinned: boolean;
};

export function TerminalTab({ termPort, termPinned }: Props) {
  const [pinning, setPinning] = useState(false);

  const url = useMemo(() => {
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol; // "http:" or "https:"
    const host = window.location.hostname;
    return `${proto}//${host}:${termPort}/`;
  }, [termPort]);

  async function togglePin() {
    setPinning(true);
    try {
      await api.setPin(!termPinned);
    } finally {
      setPinning(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "#0d0d1a",
          borderBottom: "1px solid #2a2a40",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, color: "#666", flex: 1 }}>
          tmux ↔ wterm @ <code>{url}</code>
        </span>
        <button
          onClick={togglePin}
          disabled={pinning}
          style={{
            padding: "3px 10px",
            background: termPinned ? "#a37" : "transparent",
            color: termPinned ? "#fff" : "#9090a8",
            border: `1px solid ${termPinned ? "#a37" : "#2a2a40"}`,
            borderRadius: 3,
            cursor: pinning ? "wait" : "pointer",
            fontSize: 11,
          }}
          title={
            termPinned
              ? "Pinned — voice target switches won't move the terminal"
              : "Following — terminal follows voice target switches"
          }
        >
          {termPinned ? "📌 pinned" : "follow"}
        </button>
      </div>
      <iframe
        src={url}
        style={{
          flex: 1,
          width: "100%",
          border: "none",
          background: "#1e1e1e",
        }}
        title="wterm"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
