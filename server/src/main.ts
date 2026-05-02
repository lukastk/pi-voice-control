import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mountApi } from "./http.ts";

const PORT = Number(process.env.PORT ?? 7890);
const BIND = process.env.BIND ?? "0.0.0.0";

const repoRoot = join(import.meta.dir, "..", "..");
const clientDist = join(repoRoot, "client", "dist");

const app = new Hono();

mountApi(app);

if (existsSync(clientDist)) {
  app.use("/*", serveStatic({ root: "./client/dist" }));
} else {
  app.get("/*", (c) =>
    c.text(
      `client/dist not built yet. Run: cd client && bun run build`,
      503,
    ),
  );
}

console.log(`[server] listening on http://${BIND}:${PORT}`);
console.log(`[server] client dist: ${clientDist} (${existsSync(clientDist) ? "ok" : "missing"})`);

export default {
  port: PORT,
  hostname: BIND,
  fetch: app.fetch,
};
