import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalTab } from "./tabs/TerminalTab.tsx";
import { SessionsTab } from "./tabs/SessionsTab.tsx";
import { PromptTab } from "./tabs/PromptTab.tsx";
import { SettingsTab } from "./tabs/SettingsTab.tsx";
import { useServerState } from "./state.ts";
import { useVoice, type Toast } from "./voice.ts";
import { api } from "./api.ts";
import { basename } from "./util.ts";

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <div className="toast-body">
            {t.source && <div className="toast-source">{t.source}</div>}
            <div>{t.message}</div>
          </div>
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

type TabId = "terminal" | "sessions" | "prompt" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "sessions", label: "Sessions" },
  { id: "prompt", label: "Voice prompt" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("sessions");
  const server = useServerState();
  const voice = useVoice();

  const connectedSession = useMemo(() => {
    const v = voice.state;
    if (v.kind !== "connected") return null;
    return server.sessions.find((s) => s.socketPath === v.socketPath) ?? null;
  }, [voice.state, server.sessions]);

  const turnMode = server.config?.voice.turnMode ?? "vad";
  async function toggleTurnMode() {
    if (!server.config) return;
    const next: "vad" | "manual" = turnMode === "vad" ? "manual" : "vad";
    try {
      await api.putConfig({ voice: { turnMode: next } });
      if (voice.state.kind === "connected") {
        await voice.setMicMutedExplicit(next === "manual");
      }
    } catch (err: any) {
      console.error("[turn-mode] toggle failed:", err);
    }
  }

  /**
   * Disconnect + reconnect the current voice target so freshly-saved STT/TTS
   * settings take effect. Wired from SettingsTab's "Save & reconnect" button.
   */
  async function reconnectVoice() {
    const v = voice.state;
    if (v.kind !== "connected") return;
    const socketPath = v.socketPath;
    await voice.disconnect();
    // Brief pause so the server's deleteDispatch lands before the new one.
    await new Promise((r) => setTimeout(r, 400));
    await voice.connect(socketPath, {
      turnMode: server.config?.voice.turnMode ?? "vad",
    });
  }
  const [resolveStatus, setResolveStatus] = useState<string | null>(null);
  const lastResolvedFolder = useRef<string | null | undefined>(undefined);

  // Resolve default folder whenever it changes (including initial load and
  // any later edit via Settings). Triggers a spawn if spawnIfMissing is on.
  useEffect(() => {
    if (!server.config) return;
    const folder = server.config.startup.defaultFolder;
    if (folder === lastResolvedFolder.current) return;
    lastResolvedFolder.current = folder;
    if (!folder) {
      setResolveStatus(null);
      return;
    }
    setResolveStatus(`resolving ${folder}…`);
    api.resolveDefault()
      .then((res) => {
        if (res.kind === "match") {
          setResolveStatus(`matched existing session in ${folder}`);
        } else if (res.kind === "spawned") {
          setResolveStatus(`spawned new Pi in ${folder}`);
        } else if (res.kind === "missing") {
          setResolveStatus(`no session in ${folder} (spawn-if-missing is off)`);
        } else if (res.kind === "error") {
          setResolveStatus(`spawn failed: ${res.message}`);
        } else {
          setResolveStatus(null);
        }
      })
      .catch((err) => setResolveStatus(`error: ${err.message}`));
  }, [server.config]);

  return (
    <div className="app">
      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="tabbar-spacer" />
        <button
          className={`mode-btn mode-${turnMode}`}
          onClick={toggleTurnMode}
          title={
            turnMode === "vad"
              ? "Auto-detect end of speech via VAD. Click to switch to push-to-talk."
              : "Push-to-talk: mic stays muted until you tap Talk. Click to switch to VAD."
          }
        >
          {turnMode === "vad" ? "VAD" : "PTT"}
        </button>
        {voice.state.kind === "connected" && turnMode === "manual" && (
          <button
            className={`talk-btn ${voice.micMuted ? "" : "talk-btn-active"}`}
            onClick={() => voice.toggleMic()}
            title={voice.micMuted ? "Tap to start talking" : "Tap to stop talking"}
          >
            {voice.micMuted ? "🎤 Tap to talk" : "🎤 Talking — tap to stop"}
          </button>
        )}
        {voice.state.kind === "connected" && connectedSession && (
          <span className="session-label" title={connectedSession.cwd ?? connectedSession.socketPath}>
            {connectedSession.cwd ? basename(connectedSession.cwd) : connectedSession.sessionId.slice(0, 8)}
          </span>
        )}
        <span
          className={`voice-badge voice-${voice.state.kind}`}
          title={`voice: ${voice.state.kind}`}
        >
          {voice.state.kind === "connected" ? "● voice" : voice.state.kind === "connecting" ? "… voice" : ""}
        </span>
        <span className={`health health-${server.health}`} title={`server ${server.health}`}>
          ●
        </span>
      </nav>
      <ToastStack toasts={voice.toasts} onDismiss={voice.dismissToast} />
      <main className="content">
        <div style={{ display: tab === "terminal" ? "block" : "none", height: "100%" }}>
          <TerminalTab termPort={server.termPort} termPinned={server.termPinned} />
        </div>
        {tab === "sessions" && (
          <SessionsTab
            sessions={server.sessions}
            config={server.config}
            voice={voice}
            onRefresh={server.refreshSessions}
            resolveStatus={resolveStatus}
          />
        )}
        {tab === "prompt" && (
          <PromptTab prompt={server.prompt} voiceConnected={voice.state.kind === "connected"} />
        )}
        {tab === "settings" && (
          <SettingsTab
            config={server.config}
            voiceConnected={voice.state.kind === "connected"}
            onReconnect={reconnectVoice}
          />
        )}
      </main>
    </div>
  );
}
