import { useEffect, useState } from "react";
import { api, type Config } from "../api.ts";

type Props = { config: Config | null };

export function SettingsTab({ config }: Props) {
  const [defaultFolder, setDefaultFolder] = useState<string>("");
  const [tmuxSocket, setTmuxSocket] = useState<string>("");
  const [spawnIfMissing, setSpawnIfMissing] = useState<boolean>(true);
  const [spawnTmuxSession, setSpawnTmuxSession] = useState<string>("");

  const [earconsEnabled, setEarconsEnabled] = useState(true);
  const [earconOver, setEarconOver] = useState(true);
  const [earconCopy, setEarconCopy] = useState(true);
  const [earconOut, setEarconOut] = useState(true);
  const [earconVolume, setEarconVolume] = useState(1);

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setDefaultFolder(config.startup.defaultFolder ?? "");
    setTmuxSocket(config.tmux.socketName);
    setSpawnIfMissing(config.startup.spawnIfMissing);
    setSpawnTmuxSession(config.startup.spawnTmuxSession);
    setEarconsEnabled(config.voice.earcons.enabled);
    setEarconOver(config.voice.earcons.over);
    setEarconCopy(config.voice.earcons.copy);
    setEarconOut(config.voice.earcons.out);
    setEarconVolume(config.voice.earcons.volume);
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
        voice: {
          earcons: {
            enabled: earconsEnabled,
            over: earconOver,
            copy: earconCopy,
            out: earconOut,
            volume: earconVolume,
          },
        },
      });
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!config) return <div style={{ padding: 16, color: "#888" }}>Loading config…</div>;

  return (
    <div style={{ padding: 16, maxWidth: 760, height: "100%", overflowY: "auto" }}>
      <h2 style={{ fontSize: 14, color: "#c0c0d0", marginBottom: 12 }}>Settings</h2>

      <Section title="Pi sessions">
        <Field label="Default folder">
          <input
            type="text"
            value={defaultFolder}
            placeholder="/Users/you/dev/myproject (leave empty for explicit pick)"
            onChange={(e) => setDefaultFolder(e.target.value)}
            style={inputStyle}
          />
          <p style={hintStyle}>
            Server checks for a Pi running in this folder on UI start.
            If missing and Spawn-if-missing is on, it spawns one in tmux.
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
              Start <code>pi</code> in default folder when no live session matches
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
            Passed as <code>tmux -L &lt;name&gt;</code>. Changing this requires a server restart for wterm to follow.
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
            When spawning a Pi, a window is created inside this tmux session.
          </p>
        </Field>
      </Section>

      <Section title="Earcons (radio etiquette tones)">
        <Field label="Enabled">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={earconsEnabled}
              onChange={(e) => setEarconsEnabled(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Master toggle</span>
          </label>
        </Field>
        <Field label="Per-event">
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={earconOver}
                disabled={!earconsEnabled}
                onChange={(e) => setEarconOver(e.target.checked)}
              />
              over <span style={{ color: "#666" }}>(user-stop)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={earconCopy}
                disabled={!earconsEnabled}
                onChange={(e) => setEarconCopy(e.target.checked)}
              />
              copy <span style={{ color: "#666" }}>(agent-start)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={earconOut}
                disabled={!earconsEnabled}
                onChange={(e) => setEarconOut(e.target.checked)}
              />
              out <span style={{ color: "#666" }}>(agent-end)</span>
            </label>
          </div>
        </Field>
        <Field label={`Volume — ${Math.round(earconVolume * 100)}%`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={earconVolume}
            disabled={!earconsEnabled}
            onChange={(e) => setEarconVolume(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            Earcons take effect on the next voice connection (worker reads this from the dispatch metadata).
          </p>
        </Field>
      </Section>

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 12, color: "#9090a8", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {title}
      </h3>
      <div style={{ paddingLeft: 4 }}>{children}</div>
    </section>
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
