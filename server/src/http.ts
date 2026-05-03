import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { dispatchVoiceAgent, deleteDispatch } from "./livekit.ts";
import {
  getCurrentTarget,
  setCurrentTarget,
  getPinned,
  setPinned,
} from "./state.ts";
import { getConfig, updateConfig, configPath } from "./config/store.ts";
import { getSessionsSnapshot, pollOnce } from "./sessions/poller.ts";
import { findSessionByFolder } from "./sessions/select.ts";
import { spawnPiInFolder } from "./tmux/spawn.ts";
import { switchClientTo, targetForSession } from "./tmux/focus.ts";
import { publish, subscribe } from "./events/bus.ts";
import { readPrompt, writePrompt, resetPromptToDefault } from "./prompt/file.ts";
import {
  appendSystemPromptToSocket,
  clearSystemPromptOnSocket,
} from "./prompt/inject.ts";
import { expandTilde } from "./util/path.ts";

type ElevenLabsVoice = { voice_id: string; name: string; category?: string };

let elevenLabsVoiceCache: { fetchedAt: number; voices: ElevenLabsVoice[] } | null = null;

async function fetchElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY / ELEVEN_API_KEY not set");
  // 5 minute cache — voices don't change often, and the dropdown re-renders
  // every Settings tab visit.
  if (elevenLabsVoiceCache && Date.now() - elevenLabsVoiceCache.fetchedAt < 5 * 60_000) {
    return elevenLabsVoiceCache.voices;
  }
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { voices: ElevenLabsVoice[] };
  const voices = (data.voices ?? []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category,
  }));
  elevenLabsVoiceCache = { fetchedAt: Date.now(), voices };
  return voices;
}

const WTERM_PORT = Number(process.env.WTERM_PORT ?? 7891);

export function mountApi(app: Hono) {
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "voice-agent-bridge",
      uptime: process.uptime(),
      now: new Date().toISOString(),
      currentTarget: getCurrentTarget(),
      configPath: configPath(),
      term: { port: WTERM_PORT, pinned: getPinned() },
    }),
  );

  app.post("/api/term/pin", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const pin = !!body.pin;
    setPinned(pin);
    publish({ type: "term:pin", data: { pinned: pin } });
    return c.json({ ok: true, pinned: pin });
  });

  app.get("/api/sessions", (c) => c.json(getSessionsSnapshot()));

  app.post("/api/sessions/refresh", async (c) => {
    const sessions = await pollOnce();
    return c.json(sessions);
  });

  app.post("/api/sessions/select", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const socketPath = typeof body.socketPath === "string" ? body.socketPath : null;
    if (!socketPath) {
      return c.json({ error: "socketPath required" }, 400);
    }
    if (!existsSync(socketPath)) {
      return c.json({ error: `socket does not exist: ${socketPath}` }, 404);
    }

    const existing = getCurrentTarget();
    if (existing) {
      await deleteDispatch(existing.roomName, existing.dispatchId);
      setCurrentTarget(null);
    }

    let appendedPrompt: string | undefined;
    try {
      appendedPrompt = readPrompt().body;
    } catch (err) {
      console.error("[prompt] read failed; falling back to worker default:", err);
    }

    const cfg = getConfig();
    try {
      const result = await dispatchVoiceAgent({
        socketPath,
        appendSystemPrompt: appendedPrompt,
        earcons: cfg.voice.earcons,
        stt: cfg.voice.stt,
        tts: cfg.voice.tts,
      });
      setCurrentTarget({
        socketPath,
        roomName: result.roomName,
        dispatchId: result.dispatchId,
        startedAt: Date.now(),
      });
      publish({ type: "voice:state", data: { state: "dispatching", target: socketPath } });

      // wterm follow: move the wterm pty's tmux client to this session's
      // pane, unless the user has pinned the terminal view. Goes through
      // the wterm subprocess's /_switch endpoint so we can target the right
      // client when multiple tabs are open.
      if (!getPinned()) {
        const session = getSessionsSnapshot().find((s) => s.socketPath === socketPath);
        const target = session ? targetForSession(session) : null;
        if (target) {
          const result = await switchClientTo(target);
          console.log(`[tmux] switch-client -t ${target}:`, result);
        }
      }

      return c.json(result);
    } catch (err: any) {
      return c.json({ error: `dispatch failed: ${err.message}` }, 500);
    }
  });

  app.post("/api/sessions/release", async (c) => {
    const t = getCurrentTarget();
    if (!t) return c.json({ ok: true, alreadyEmpty: true });
    await deleteDispatch(t.roomName, t.dispatchId);
    setCurrentTarget(null);
    publish({ type: "voice:state", data: { state: "released" } });
    return c.json({ ok: true });
  });

  /**
   * Resolve which session should be auto-selected on UI startup.
   *   - If config.startup.defaultFolder is null → return { kind: "none" }.
   *   - If a live session matches → return { kind: "match", session }.
   *   - Else if spawnIfMissing → spawn one and wait for the socket.
   *   - Else return { kind: "missing" }.
   */
  /**
   * Always spawn a fresh Pi in the given folder (or config.defaultFolder if
   * omitted). Unlike /api/sessions/default this does NOT first check for an
   * existing matching session — it always creates a new tmux window + Pi
   * process. Useful when the user wants a parallel session in the same
   * folder.
   */
  app.post("/api/sessions/spawn", async (c) => {
    const cfg = getConfig();
    const body = await c.req.json().catch(() => ({}));
    const requested = typeof body.folder === "string" ? body.folder : null;
    const folderRaw = requested ?? cfg.startup.defaultFolder;
    if (!folderRaw) {
      return c.json({ error: "no folder specified and no defaultFolder configured" }, 400);
    }
    const folder = expandTilde(folderRaw);
    try {
      const newPath = await spawnPiInFolder({
        tmuxSocketName: cfg.tmux.socketName,
        spawnTmuxSession: cfg.startup.spawnTmuxSession,
        socketsDir: cfg.pi.socketsDir,
        folder,
      });
      const fresh = await pollOnce();
      const session = fresh.find((s) => s.socketPath === newPath) ?? null;
      return c.json({ ok: true, socketPath: newPath, session, folder });
    } catch (err: any) {
      return c.json({ error: `spawn failed: ${err.message}` }, 500);
    }
  });

  app.get("/api/sessions/default", async (c) => {
    const cfg = getConfig();
    const folder = cfg.startup.defaultFolder ? expandTilde(cfg.startup.defaultFolder) : null;
    if (!folder) return c.json({ kind: "none" });

    let sessions = getSessionsSnapshot();
    if (sessions.length === 0) sessions = await pollOnce();
    const match = findSessionByFolder(sessions, folder);
    if (match) return c.json({ kind: "match", session: match });

    if (!cfg.startup.spawnIfMissing) {
      return c.json({ kind: "missing", folder });
    }

    try {
      const newPath = await spawnPiInFolder({
        tmuxSocketName: cfg.tmux.socketName,
        spawnTmuxSession: cfg.startup.spawnTmuxSession,
        socketsDir: cfg.pi.socketsDir,
        folder,
      });
      // Force a poll so the new session lands in the snapshot.
      const fresh = await pollOnce();
      const session =
        fresh.find((s) => s.socketPath === newPath) ?? null;
      return c.json({ kind: "spawned", session, socketPath: newPath });
    } catch (err: any) {
      return c.json({ kind: "error", message: err.message }, 500);
    }
  });

  app.get("/api/config", (c) => c.json(getConfig()));

  app.put("/api/config", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid body" }, 400);
    }
    const next = updateConfig(body);
    publish({ type: "config:updated", data: next });
    return c.json(next);
  });

  app.get("/api/voices/elevenlabs", async (c) => {
    try {
      const voices = await fetchElevenLabsVoices();
      return c.json({ ok: true, voices });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 502);
    }
  });

  app.get("/api/prompt", (c) => {
    try {
      return c.json(readPrompt());
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.put("/api/prompt", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.body !== "string") {
      return c.json({ error: "body required" }, 400);
    }
    const snap = writePrompt(body.body);
    publish({ type: "prompt:updated", data: snap });

    // Live re-inject to the current voice target so the next agent turn uses
    // the updated prompt. Pi's rpc-socket extension applies appendSystemPrompt
    // via before_agent_start, so the in-flight turn (if any) keeps its
    // current prompt; the next turn picks up the new one.
    const t = getCurrentTarget();
    let injected: { ok: boolean; error?: string } | null = null;
    if (t) injected = await appendSystemPromptToSocket(t.socketPath, snap.body);
    return c.json({ ...snap, injected });
  });

  app.post("/api/prompt/reinject", async (c) => {
    const t = getCurrentTarget();
    if (!t) return c.json({ ok: false, error: "no current voice target" }, 409);
    const snap = readPrompt();
    const result = await appendSystemPromptToSocket(t.socketPath, snap.body);
    return c.json({ ...snap, injected: result });
  });

  app.post("/api/prompt/reset", async (c) => {
    const snap = resetPromptToDefault();
    publish({ type: "prompt:updated", data: snap });
    const t = getCurrentTarget();
    let injected: { ok: boolean; error?: string } | null = null;
    if (t) injected = await appendSystemPromptToSocket(t.socketPath, snap.body);
    return c.json({ ...snap, injected });
  });

  app.post("/api/prompt/clear", async (c) => {
    const t = getCurrentTarget();
    if (!t) return c.json({ ok: false, error: "no current voice target" }, 409);
    const result = await clearSystemPromptOnSocket(t.socketPath);
    return c.json(result);
  });

  app.get("/events", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            // controller closed
          }
        };

        send("hello", { ok: true, at: Date.now() });
        send("sessions:update", getSessionsSnapshot());
        send("config:updated", getConfig());
        send("term:pin", { pinned: getPinned() });
        try {
          send("prompt:updated", readPrompt());
        } catch {
          // ignore — file unreadable on first open is fine
        }

        const unsubscribe = subscribe((event) => {
          send(event.type, event.data);
        });

        const ping = setInterval(() => send("ping", { at: Date.now() }), 15000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(ping);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });
}
