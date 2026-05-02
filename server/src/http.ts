import type { Hono } from "hono";
import { dispatchVoiceAgent, deleteDispatch } from "./livekit.ts";
import { getCurrentTarget, setCurrentTarget } from "./state.ts";
import { existsSync } from "node:fs";

export function mountApi(app: Hono) {
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "voice-agent-bridge",
      uptime: process.uptime(),
      now: new Date().toISOString(),
      currentTarget: getCurrentTarget(),
    }),
  );

  // Phase 2 will populate this from the rpc-socket poller.
  app.get("/api/sessions", (c) => c.json([]));
  app.post("/api/sessions/refresh", (c) => c.json([]));

  app.post("/api/sessions/select", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const socketPath = typeof body.socketPath === "string" ? body.socketPath : null;
    if (!socketPath) {
      return c.json({ error: "socketPath required" }, 400);
    }
    if (!existsSync(socketPath)) {
      return c.json({ error: `socket does not exist: ${socketPath}` }, 404);
    }

    // Tear down any existing target before starting a new one.
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
    return c.json({ ok: true });
  });

  app.get("/api/prompt", (c) => c.json({ path: null, body: "", mtime: null }));
  app.put("/api/prompt", (c) => c.json({ error: "not implemented in phase 1" }, 501));
  app.get("/api/config", (c) => c.json({}));
  app.put("/api/config", (c) => c.json({ error: "not implemented in phase 1" }, 501));

  app.get("/events", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };
        send("hello", { ok: true, at: Date.now() });
        const interval = setInterval(() => send("ping", { at: Date.now() }), 15000);
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(interval);
          controller.close();
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
