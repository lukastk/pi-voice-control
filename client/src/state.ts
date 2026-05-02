import { useEffect, useRef, useState } from "react";
import { api, type Config, type PromptSnapshot } from "./api.ts";
import type { PiSession } from "./types.ts";

export type ServerState = {
  health: "unknown" | "ok" | "down";
  sessions: PiSession[];
  config: Config | null;
  termPort: number;
  termPinned: boolean;
  prompt: PromptSnapshot | null;
};

export function useServerState(): ServerState & {
  refreshSessions: () => Promise<void>;
} {
  const [state, setState] = useState<ServerState>({
    health: "unknown",
    sessions: [],
    config: null,
    termPort: 7891,
    termPinned: false,
    prompt: null,
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([api.health(), api.listSessions(), api.getConfig(), api.getPrompt()])
      .then(([h, sessions, config, prompt]) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          health: h.ok ? "ok" : "down",
          sessions,
          config,
          prompt,
          termPort: h.term?.port ?? prev.termPort,
          termPinned: h.term?.pinned ?? prev.termPinned,
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, health: "down" }));
      });

    const es = new EventSource("/events");
    esRef.current = es;
    es.addEventListener("sessions:update", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as PiSession[];
        setState((prev) => ({ ...prev, sessions: data }));
      } catch {
        // ignore
      }
    });
    es.addEventListener("config:updated", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as Config;
        setState((prev) => ({ ...prev, config: data }));
      } catch {
        // ignore
      }
    });
    es.addEventListener("term:pin", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { pinned: boolean };
        setState((prev) => ({ ...prev, termPinned: data.pinned }));
      } catch {
        // ignore
      }
    });
    es.addEventListener("prompt:updated", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as PromptSnapshot;
        setState((prev) => ({ ...prev, prompt: data }));
      } catch {
        // ignore
      }
    });
    es.onerror = () => setState((prev) => ({ ...prev, health: "down" }));
    es.onopen = () => setState((prev) => ({ ...prev, health: "ok" }));

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const refreshSessions = async () => {
    const fresh = await api.refreshSessions();
    setState((prev) => ({ ...prev, sessions: fresh }));
  };

  return { ...state, refreshSessions };
}
