import { useEffect, useRef, useState } from "react";
import { TerminalTab } from "./tabs/TerminalTab.tsx";
import { SessionsTab } from "./tabs/SessionsTab.tsx";
import { PromptTab } from "./tabs/PromptTab.tsx";
import { SettingsTab } from "./tabs/SettingsTab.tsx";
import { useServerState } from "./state.ts";
import { useVoice } from "./voice.ts";
import { api } from "./api.ts";

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
        {tab === "settings" && <SettingsTab config={server.config} />}
      </main>
    </div>
  );
}
