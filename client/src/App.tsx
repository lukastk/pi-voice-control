import { useEffect, useState } from "react";
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
  const [autoTried, setAutoTried] = useState(false);

  // Resolve default folder once, after config has loaded.
  useEffect(() => {
    if (autoTried || !server.config) return;
    if (!server.config.startup.defaultFolder) {
      setAutoTried(true);
      return;
    }
    setAutoTried(true);
    api.resolveDefault().then((res) => {
      if (res.kind === "match" || res.kind === "spawned") {
        if (res.session) {
          // Pre-highlight only — don't auto-connect (user preference).
          // The Sessions tab visually marks the matching session as default.
        }
      }
    }).catch(() => {
      // ignore — error surfaces in Sessions tab via the event log
    });
  }, [server.config, autoTried]);

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
        {tab === "terminal" && <TerminalTab />}
        {tab === "sessions" && (
          <SessionsTab
            sessions={server.sessions}
            config={server.config}
            voice={voice}
            onRefresh={server.refreshSessions}
          />
        )}
        {tab === "prompt" && <PromptTab />}
        {tab === "settings" && <SettingsTab config={server.config} />}
      </main>
    </div>
  );
}
