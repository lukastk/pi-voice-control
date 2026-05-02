import { useEffect, useState } from "react";
import { api, type PromptSnapshot } from "../api.ts";

type Props = {
  prompt: PromptSnapshot | null;
  voiceConnected: boolean;
};

export function PromptTab({ prompt, voiceConnected }: Props) {
  const [body, setBody] = useState("");
  const [original, setOriginal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (prompt) {
      setBody(prompt.body);
      setOriginal(prompt.body);
    }
  }, [prompt]);

  const dirty = body !== original;

  async function save() {
    setBusy("save");
    setStatus(null);
    try {
      const res = await api.putPrompt(body);
      setOriginal(res.body);
      if (res.injected?.ok === false) {
        setStatus({ kind: "warn", text: `saved; live inject failed: ${res.injected.error}` });
      } else if (res.injected?.ok) {
        setStatus({ kind: "ok", text: "saved + injected to current voice target" });
      } else {
        setStatus({ kind: "ok", text: "saved (no active voice target — applies on next connect)" });
      }
    } catch (err: any) {
      setStatus({ kind: "err", text: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function reinject() {
    setBusy("reinject");
    setStatus(null);
    try {
      const res = await api.reinjectPrompt();
      if (res.injected?.ok) setStatus({ kind: "ok", text: "re-injected" });
      else setStatus({ kind: "warn", text: `inject failed: ${res.injected?.error ?? "unknown"}` });
    } catch (err: any) {
      setStatus({ kind: "err", text: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!confirm("Reset to default voice prompt? Your edits will be overwritten.")) return;
    setBusy("reset");
    setStatus(null);
    try {
      const res = await api.resetPrompt();
      setBody(res.body);
      setOriginal(res.body);
      setStatus({ kind: "ok", text: "reset to default" });
    } catch (err: any) {
      setStatus({ kind: "err", text: err.message });
    } finally {
      setBusy(null);
    }
  }

  if (!prompt) {
    return <div style={{ padding: 16, color: "#888" }}>Loading prompt…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 14 }}>
      <header style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, color: "#c0c0d0", flex: 1 }}>Voice prompt</h2>
        <span style={{ fontSize: 11, color: "#666", fontFamily: "monospace" }}>
          {prompt.path}
        </span>
      </header>
      <p style={{ fontSize: 11, color: "#888", marginBottom: 8, lineHeight: 1.5 }}>
        Appended to Pi's system prompt on every voice turn. Pi already loads{" "}
        <code>~/.pi/agent/AGENTS.md</code> through its normal context-file discovery; this is
        added on top via <code>appendSystemPrompt</code>. Saves take effect on the next agent
        turn.
      </p>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1,
          minHeight: 240,
          padding: 10,
          background: "#0d0d1a",
          color: "#e6e6f0",
          border: `1px solid ${dirty ? "#5a57b3" : "#2a2a40"}`,
          borderRadius: 4,
          fontFamily: "'SF Mono', monospace",
          fontSize: 12,
          lineHeight: 1.5,
          resize: "none",
        }}
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={save}
          disabled={!dirty || busy !== null}
          style={btn(dirty ? "#5a57b3" : "#333")}
        >
          {busy === "save" ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
        <button
          onClick={reinject}
          disabled={busy !== null || !voiceConnected}
          style={btn("#3a4a7a")}
          title={voiceConnected ? "" : "No active voice target"}
        >
          {busy === "reinject" ? "Injecting…" : "Re-inject now"}
        </button>
        <button onClick={reset} disabled={busy !== null} style={btn("#444")}>
          {busy === "reset" ? "Resetting…" : "Reset to default"}
        </button>
        {dirty && <span style={{ fontSize: 11, color: "#fa5" }}>unsaved changes</span>}
        {status && (
          <span
            style={{
              fontSize: 11,
              color:
                status.kind === "ok" ? "#7a7" : status.kind === "warn" ? "#fa5" : "#f66",
            }}
          >
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}

function btn(bg: string): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
  };
}
