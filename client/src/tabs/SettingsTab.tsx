import { useEffect, useState } from "react";
import { api, type Config } from "../api.ts";

type Props = { config: Config | null };

export function SettingsTab({ config }: Props) {
  const [defaultFolder, setDefaultFolder] = useState<string>("");
  const [tmuxSocket, setTmuxSocket] = useState<string>("");
  const [spawnIfMissing, setSpawnIfMissing] = useState<boolean>(true);
  const [spawnTmuxSession, setSpawnTmuxSession] = useState<string>("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setDefaultFolder(config.startup.defaultFolder ?? "");
    setTmuxSocket(config.tmux.socketName);
    setSpawnIfMissing(config.startup.spawnIfMissing);
    setSpawnTmuxSession(config.startup.spawnTmuxSession);
  }, [config]);

  async function save() {
    setError(null);
    try {
      await api.putConfig({
        tmux: { socketName: tmuxSocket || "mysystem" },
        startup: {
          defaultFolder: defaultFolder.trim() || null,
          spawnIfMissing,
          spawnTmuxSession: spawnTmuxSession || "voice-bridge-pi",
        },
      });
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!config) {
    return <div style={{ padding: 16, color: "#888" }}>Loading config…</div>;
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2 style={{ fontSize: 14, color: "#c0c0d0", marginBottom: 12 }}>Settings</h2>

      <Field label="Default folder">
        <input
          type="text"
          value={defaultFolder}
          placeholder="/Users/you/dev/myproject (leave empty for explicit pick)"
          onChange={(e) => setDefaultFolder(e.target.value)}
          style={inputStyle}
        />
        <p style={hintStyle}>
          On UI start, server checks for a Pi session running in this folder. If found, it's
          pinned to the top of the Sessions list. If not and Spawn-if-missing is on, the server
          starts one in tmux.
        </p>
      </Field>

      <Field label="Spawn if missing">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={spawnIfMissing}
            onChange={(e) => setSpawnIfMissing(e.target.checked)}
          />
          <span style={{ fontSize: 13 }}>
            Start <code>pi</code> in the default folder when no live session matches
          </span>
        </label>
      </Field>

      <Field label="tmux socket">
        <input
          type="text"
          value={tmuxSocket}
          onChange={(e) => setTmuxSocket(e.target.value)}
          style={inputStyle}
        />
        <p style={hintStyle}>
          The socket name passed as <code>tmux -L &lt;name&gt;</code>. Default: <code>mysystem</code>.
        </p>
      </Field>

      <Field label="Spawn tmux session">
        <input
          type="text"
          value={spawnTmuxSession}
          onChange={(e) => setSpawnTmuxSession(e.target.value)}
          style={inputStyle}
        />
        <p style={hintStyle}>
          When spawning a Pi, a window is created inside this tmux session (created if missing).
        </p>
      </Field>

      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button onClick={save} style={btnPrimary}>
          Save
        </button>
        {savedAt && (
          <span style={{ fontSize: 11, color: "#7a7" }}>
            saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        {error && <span style={{ fontSize: 11, color: "#f66" }}>{error}</span>}
      </div>

      <details style={{ marginTop: 24 }}>
        <summary style={{ fontSize: 11, color: "#666", cursor: "pointer" }}>raw config</summary>
        <pre
          style={{
            background: "#0d0d1a",
            padding: 10,
            borderRadius: 4,
            fontFamily: "'SF Mono', monospace",
            fontSize: 10,
            color: "#888",
            marginTop: 6,
            overflowX: "auto",
          }}
        >
          {JSON.stringify(config, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11, color: "#9090a8", marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "#0d0d1a",
  color: "#e6e6f0",
  border: "1px solid #2a2a40",
  borderRadius: 4,
  fontFamily: "'SF Mono', monospace",
  fontSize: 12,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  lineHeight: 1.5,
  marginTop: 4,
};

const btnPrimary: React.CSSProperties = {
  padding: "6px 16px",
  background: "#5a57b3",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
};
