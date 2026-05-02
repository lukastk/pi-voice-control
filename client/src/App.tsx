import { useEffect, useState } from "react";
import { TerminalTab } from "./tabs/TerminalTab.tsx";
import { SessionsTab } from "./tabs/SessionsTab.tsx";
import { PromptTab } from "./tabs/PromptTab.tsx";
import { SettingsTab } from "./tabs/SettingsTab.tsx";

type TabId = "terminal" | "sessions" | "prompt" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "sessions", label: "Sessions" },
  { id: "prompt", label: "Voice prompt" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("terminal");
  const [health, setHealth] = useState<"unknown" | "ok" | "down">("unknown");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setHealth(d.ok ? "ok" : "down");
      })
      .catch(() => {
        if (!cancelled) setHealth("down");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <span className={`health health-${health}`} title={`server ${health}`}>
          ●
        </span>
      </nav>
      <main className="content">
        {tab === "terminal" && <TerminalTab />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "prompt" && <PromptTab />}
        {tab === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}
