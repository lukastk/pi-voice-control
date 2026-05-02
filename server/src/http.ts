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

    try {
      const result = await dispatchVoiceAgent({ socketPath });
      setCurrentTarget({
        socketPath,
        roomName: result.roomName,
        dispatchId: result.dispatchId,
        startedAt: Date.now(),
      });
      publish({ type: "voice:state", data: { state: "dispatching", target: socketPath } });

      // wterm follow: move the active tmux client to this session's pane,
      // unless the user has pinned the terminal view.
      if (!getPinned()) {
        const session = getSessionsSnapshot().find((s) => s.socketPath === socketPath);
        const target = session ? targetForSession(session) : null;
        if (target) {
          switchClientTo(getConfig().tmux.socketName, target);
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
  app.get("/api/sessions/default", async (c) => {
    const cfg = getConfig();
    const folder = cfg.startup.defaultFolder;
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

  app.get("/api/prompt", (c) => c.json({ path: null, body: "", mtime: null }));
  app.put("/api/prompt", (c) => c.json({ error: "not implemented in phase 2" }, 501));

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
