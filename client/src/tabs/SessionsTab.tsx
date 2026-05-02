import { useMemo } from "react";
import type { PiSession } from "../types.ts";
import type { Config } from "../api.ts";
import type { useVoice } from "../voice.ts";

type Props = {
  sessions: PiSession[];
  config: Config | null;
  voice: ReturnType<typeof useVoice>;
  onRefresh: () => Promise<void>;
  resolveStatus: string | null;
};

function realpathLikeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  // Approximate; the *server* does the realpath comparison authoritatively.
  // Client just normalizes trailing slashes and decoded characters.
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export function SessionsTab({ sessions, config, voice, onRefresh, resolveStatus }: Props) {
  const defaultFolder = config?.startup.defaultFolder ?? null;

  const sorted = useMemo(() => {
    const matches = (s: PiSession) =>
      defaultFolder ? realpathLikeEqual(s.cwd, defaultFolder) : false;
    return [...sessions].sort((a, b) => {
      const am = matches(a) ? 0 : 1;
      const bm = matches(b) ? 0 : 1;
      if (am !== bm) return am - bm;
      return b.lastSeen - a.lastSeen;
    });
  }, [sessions, defaultFolder]);

  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, color: "#c0c0d0", flex: 1 }}>
          Pi sessions ({sessions.length})
        </h2>
        <button onClick={() => onRefresh()} style={btnGhost}>
          Refresh
        </button>
      </header>
      {resolveStatus && (
        <div
          style={{
            marginBottom: 10,
            padding: "6px 10px",
            background: "#1a2238",
            border: "1px solid #2a4a8a",
            borderRadius: 4,
            fontSize: 11,
            color: "#a8c8ff",
          }}
        >
          {resolveStatus}
        </div>
      )}

      {sessions.length === 0 ? (
        <Empty config={config} />
      ) : (
        <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map((s) => {
            const isCurrent = voice.state.kind === "connected" && voice.state.socketPath === s.socketPath;
            const isMatch = defaultFolder ? realpathLikeEqual(s.cwd, defaultFolder) : false;
            return (
              <li key={s.sessionId} style={rowStyle(isCurrent, isMatch)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "'SF Mono', monospace", fontSize: 13, color: "#e6e6f0" }}>
                    {s.cwd ?? <span style={{ color: "#666" }}>(no cwd — older Pi)</span>}
                    {isMatch && (
                      <span style={badgeStyle("#2a4a8a", "#a8c8ff")}>default</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#9090a8", marginTop: 4 }}>
                    {s.tmux.inTmux ? (
                      <>
                        tmux:{" "}
                        <code>
                          {s.tmux.session}:{s.tmux.windowIndex}.{s.tmux.paneIndex}
                        </code>{" "}
                        ({s.tmux.window})
                      </>
                    ) : (
                      <span style={{ color: "#666" }}>not in tmux</span>
                    )}
                    {" · "}
                    <span style={{ color: s.state.idle ? "#7a7" : "#fa5" }}>
                      {s.state.idle ? "idle" : "busy"}
                    </span>
                    {s.state.contextUsage != null && (
                      <>
                        {" · "}
                        ctx {s.state.contextUsage.percent}%
                      </>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "#555",
                      fontFamily: "'SF Mono', monospace",
                      marginTop: 4,
                    }}
                  >
                    {s.socketPath}
                  </div>
                </div>
                <div>
                  {isCurrent ? (
                    <button onClick={() => voice.disconnect()} style={btnDanger}>
                      Disconnect
                    </button>
                  ) : (
                    <button onClick={() => voice.connect(s.socketPath)} style={btnPrimary}>
                      Connect voice
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {voice.log.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ fontSize: 12, color: "#9090a8", cursor: "pointer" }}>
            Voice log ({voice.log.length})
          </summary>
          <pre
            style={{
              background: "#0d0d1a",
              padding: 10,
              borderRadius: 4,
              fontFamily: "'SF Mono', monospace",
              fontSize: 11,
              maxHeight: 220,
              overflowY: "auto",
              color: "#9090a8",
              marginTop: 6,
            }}
          >
            {voice.log.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

function Empty({ config }: { config: Config | null }) {
  return (
    <div style={{ color: "#888", fontSize: 13, lineHeight: 1.6 }}>
      <p>No live Pi sessions found in <code>{config?.pi.socketsDir ?? "/tmp/pi-rpc-sockets"}</code>.</p>
      <p style={{ marginTop: 8 }}>
        Start one in tmux:
        <br />
        <code style={{ display: "block", marginTop: 6, padding: "8px 10px", background: "#0d0d1a", borderRadius: 4 }}>
          tmux -L {config?.tmux.socketName ?? "mysystem"} new-session -s pi pi
        </code>
      </p>
      {config?.startup.defaultFolder && (
        <p style={{ marginTop: 8 }}>
          Default folder is <code>{config.startup.defaultFolder}</code>. If <code>spawnIfMissing</code> is on, the
          server can start one for you on first load.
        </p>
      )}
    </div>
  );
}

function rowStyle(isCurrent: boolean, isMatch: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    background: isCurrent ? "#1a3a2e" : "#0d0d1a",
    border: `1px solid ${isCurrent ? "#3a7a4a" : isMatch ? "#3a4a7a" : "#222238"}`,
    borderRadius: 6,
  };
}

function badgeStyle(bg: string, fg: string): React.CSSProperties {
  return {
    marginLeft: 8,
    padding: "1px 6px",
    background: bg,
    color: fg,
    fontSize: 10,
    borderRadius: 3,
    verticalAlign: "1px",
  };
}

const btnPrimary: React.CSSProperties = {
  padding: "6px 14px",
  background: "#5a57b3",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

const btnDanger: React.CSSProperties = { ...btnPrimary, background: "#a33" };

const btnGhost: React.CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  color: "#9090a8",
  border: "1px solid #2a2a40",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
};
