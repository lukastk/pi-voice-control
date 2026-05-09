import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";

type Props = {
  termPort: number;
  termPinned: boolean;
  voiceConnected: boolean;
};

type FocusStatus =
  | { kind: "idle" }
  | { kind: "ok"; message: string }
  | { kind: "err"; message: string };

export function TerminalTab({ termPort, termPinned, voiceConnected }: Props) {
  const [pinning, setPinning] = useState(false);
  const [focusing, setFocusing] = useState(false);
  const [focusStatus, setFocusStatus] = useState<FocusStatus>({ kind: "idle" });

  // Auto-clear status banner after a few seconds.
  useEffect(() => {
    if (focusStatus.kind === "idle") return;
    const id = setTimeout(() => setFocusStatus({ kind: "idle" }), 4000);
    return () => clearTimeout(id);
  }, [focusStatus]);

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

  async function focusCurrent() {
    setFocusing(true);
    try {
      const res = await api.focusTerm();
      if (res.ok) {
        setFocusStatus({
          kind: "ok",
          message: `Switched ${res.switched ?? 0} client${res.switched === 1 ? "" : "s"} to ${res.target}`,
        });
      } else {
        setFocusStatus({ kind: "err", message: res.error ?? "switch failed" });
      }
    } catch (err: any) {
      setFocusStatus({ kind: "err", message: err?.message ?? "request failed" });
    } finally {
      setFocusing(false);
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
        {focusStatus.kind !== "idle" && (
          <span
            style={{
              fontSize: 11,
              color: focusStatus.kind === "ok" ? "#7c9" : "#d77",
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={focusStatus.message}
          >
            {focusStatus.message}
          </span>
        )}
        <button
          onClick={focusCurrent}
          disabled={focusing || !voiceConnected}
          style={{
            padding: "3px 10px",
            background: "transparent",
            color: voiceConnected ? "#9090a8" : "#555",
            border: "1px solid #2a2a40",
            borderRadius: 3,
            cursor: focusing ? "wait" : voiceConnected ? "pointer" : "not-allowed",
            fontSize: 11,
          }}
          title={
            voiceConnected
              ? "Switch the terminal to the active voice session's pane (overrides pin)"
              : "Connect to a Pi session first"
          }
        >
          ⇨ show this session
        </button>
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
