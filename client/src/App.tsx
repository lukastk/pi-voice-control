import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalTab } from "./tabs/TerminalTab.tsx";
import { SessionsTab } from "./tabs/SessionsTab.tsx";
import { PromptTab } from "./tabs/PromptTab.tsx";
import { SettingsTab } from "./tabs/SettingsTab.tsx";
import { TestTab } from "./tabs/TestTab.tsx";
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

type TabId = "terminal" | "sessions" | "prompt" | "settings" | "test";

const TABS: { id: TabId; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "sessions", label: "Sessions" },
  { id: "prompt", label: "Voice prompt" },
  { id: "settings", label: "Settings" },
  { id: "test", label: "Test" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("sessions");
  // Lazy-mount the terminal iframe — booting it inside a display:none parent
  // means wterm's ResizeObserver measures 0×0 and the grid sticks at 80×24
  // even after the tab is revealed.
  const [terminalVisited, setTerminalVisited] = useState(tab === "terminal");
  useEffect(() => {
    if (tab === "terminal") setTerminalVisited(true);
  }, [tab]);
  const server = useServerState();
  const voice = useVoice();

  const connectedSession = useMemo(() => {
    const v = voice.state;
    if (v.kind !== "connected") return null;
    return server.sessions.find((s) => s.socketPath === v.socketPath) ?? null;
  }, [voice.state, server.sessions]);

  const turnMode = server.config?.voice.turnMode ?? "vad";
  const micEnabled = server.config?.voice.micEnabled ?? true;
  const micDeviceId = server.config?.voice.micDeviceId ?? null;
  async function toggleTurnMode() {
    if (!server.config) return;
    // Cycle VAD → PTT → KW → VAD. Switching between VAD and PTT is
    // free (just adjusts mic mute). Switching to or from KW changes
    // the framework's turnDetection (locked at session-start), so we
    // also disconnect/reconnect the live session.
    const cycle: Array<"vad" | "manual" | "keyword"> = ["vad", "manual", "keyword"];
    const next = cycle[(cycle.indexOf(turnMode) + 1) % cycle.length]!;
    const crossesKeywordBoundary = turnMode === "keyword" || next === "keyword";
    try {
      await api.putConfig({ voice: { turnMode: next } });
      if (voice.state.kind === "connected") {
        if (crossesKeywordBoundary) {
          await reconnectVoice();
        } else {
          // The master micEnabled toggle dominates: if the user has
          // muted the mic globally, stay muted regardless of mode.
          await voice.setMicMutedExplicit(next === "manual" || !micEnabled);
        }
      }
    } catch (err: any) {
      console.error("[turn-mode] toggle failed:", err);
    }
  }

  async function toggleMicEnabled() {
    if (!server.config) return;
    const next = !micEnabled;
    try {
      await api.putConfig({ voice: { micEnabled: next } });
      if (voice.state.kind === "connected") {
        // When disabling: always mute. When re-enabling: respect mode
        // (PTT stays muted-by-default, VAD/KW go hot).
        const muted = !next || turnMode === "manual";
        await voice.setMicMutedExplicit(muted);
      }
    } catch (err: any) {
      console.error("[mic-enabled] toggle failed:", err);
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
      micEnabled: server.config?.voice.micEnabled ?? true,
      micDeviceId: server.config?.voice.micDeviceId ?? null,
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

  const connected = voice.state.kind === "connected";

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
        {connected && connectedSession && (
          <span className="session-label" title={connectedSession.cwd ?? connectedSession.socketPath}>
            {connectedSession.cwd ? basename(connectedSession.cwd) : connectedSession.sessionId.slice(0, 8)}
          </span>
        )}
        <span
          className={`voice-badge voice-${voice.state.kind}`}
          title={`voice: ${voice.state.kind}`}
        >
          {connected ? "● voice" : voice.state.kind === "connecting" ? "… voice" : ""}
        </span>
        <span className={`health health-${server.health}`} title={`server ${server.health}`}>
          ●
        </span>
      </nav>
      {connected && (
        <div className="voice-bar">
          <button
            className={`mode-btn ${micEnabled ? "mic-on" : "mic-off"}`}
            onClick={toggleMicEnabled}
            title={
              micEnabled
                ? "Microphone is on. Click to mute (privacy override — keeps mode settings)."
                : "Microphone is muted. Click to re-enable listening."
            }
          >
            {micEnabled ? "🎙" : "🚫"}
          </button>
          <button
            className={`mode-btn mode-${turnMode}`}
            onClick={toggleTurnMode}
            title={
              turnMode === "vad"
                ? "VAD: auto-detect end of speech. Click to switch to push-to-talk."
                : turnMode === "manual"
                  ? "PTT: mic stays muted until you tap Talk. Click to switch to keyword mode."
                  : "Keyword: speak start/end phrases to bracket each turn. Click to switch back to VAD (will reconnect)."
            }
          >
            {turnMode === "vad" ? "VAD" : turnMode === "manual" ? "PTT" : "KW"}
          </button>
          {turnMode === "manual" && (
            <button
              className={`talk-btn ${voice.micMuted ? "" : "talk-btn-active"}`}
              onClick={() => voice.toggleMic()}
              title={voice.micMuted ? "Tap to start talking" : "Tap to stop talking"}
            >
              {voice.micMuted ? "🎤 Tap to talk" : "🎤 Talking — tap to stop"}
            </button>
          )}
          {turnMode === "keyword" && (
            <KeywordControls
              armed={voice.armed}
              onAction={(a) => voice.publishControl(a)}
            />
          )}
        </div>
      )}
      <ToastStack toasts={voice.toasts} onDismiss={voice.dismissToast} />
      <main className="content">
        {terminalVisited && (
          <div style={{ display: tab === "terminal" ? "block" : "none", height: "100%" }}>
            <TerminalTab termPort={server.termPort} termPinned={server.termPinned} />
          </div>
        )}
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
        {tab === "test" && (
          <TestTab
            sttSummary={
              server.config
                ? `${server.config.voice.stt.provider} · ${server.config.voice.stt.model}`
                : "loading…"
            }
            ttsSummary={
              server.config
                ? `${server.config.voice.tts.provider} · ${server.config.voice.tts.model}`
                : "loading…"
            }
          />
        )}
      </main>
    </div>
  );
}

/**
 * Six buttons mirroring the spoken keywords (start / end / scrap /
 * redo / replay / abort) plus the recording indicator. Each click
 * publishes a control message to the worker via the LiveKit data
 * channel; the worker's performAction() handles it the same way as
 * a spoken match. Buttons gate themselves on the armed state so a
 * misclick doesn't fire a no-op.
 *
 * Mobile-friendly: the parent .voice-bar has flex-wrap, so on a
 * narrow viewport the buttons spill onto a second row.
 */
function KeywordControls({
  armed,
  onAction,
}: {
  armed: boolean;
  onAction: (action: "start" | "end" | "scrap" | "redo" | "replay" | "abort") => void;
}) {
  return (
    <div className="kw-controls">
      {armed && (
        <span
          className="armed-indicator"
          title="Recording — speak your message, then click End or say the end phrase."
        >
          <span className="armed-dot" />
          <span style={{ marginLeft: 6 }}>recording</span>
        </span>
      )}
      <button
        className="kw-btn kw-start"
        onClick={() => onAction("start")}
        disabled={armed}
        title="Begin a new message. Same as saying the start phrase."
      >
        ▶ Start
      </button>
      <button
        className="kw-btn kw-end"
        onClick={() => onAction("end")}
        disabled={!armed}
        title="Send the current message to Pi. Same as saying the end phrase."
      >
        ✓ End
      </button>
      <button
        className="kw-btn kw-scrap"
        onClick={() => onAction("scrap")}
        disabled={!armed}
        title="Discard the current message and stop listening."
      >
        ✗ Scrap
      </button>
      <button
        className="kw-btn kw-redo"
        onClick={() => onAction("redo")}
        disabled={!armed}
        title="Discard and start the message over."
      >
        ↻ Redo
      </button>
      <button
        className="kw-btn kw-replay"
        onClick={() => onAction("replay")}
        disabled={armed}
        title="Re-speak the agent's last response."
      >
        ↺ Replay
      </button>
      <button
        className="kw-btn kw-abort"
        onClick={() => onAction("abort")}
        title="Tell Pi to stop whatever it's doing (escape-key equivalent)."
      >
        ⊘ Abort
      </button>
    </div>
  );
}
