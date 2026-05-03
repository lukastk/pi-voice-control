import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const port = parseInt(process.env.WTERM_PORT, 10);
const tmuxSocket = process.env.TMUX_SOCKET;

if (isNaN(port))
  throw new Error("WTERM_PORT environment variable must be a valid port number");
if (!tmuxSocket)
  throw new Error("TMUX_SOCKET environment variable is required");

// Bind localhost only — Tailscale Serve listens on the Tailnet interface
// at the same port and forwards to localhost. 0.0.0.0 would collide.
const host = process.env.WTERM_BIND ?? "127.0.0.1";
const baseDir = process.cwd();

const indexHtml = readFileSync(join(baseDir, "index.html"), "utf-8");
const clientJs = readFileSync(join(baseDir, "dist/client.js"), "utf-8");
const terminalCss = readFileSync(
  join(baseDir, "node_modules/@wterm/dom/src/terminal.css"),
  "utf-8",
);

// Track live pty PIDs so the parent server can correlate them with tmux's
// list-clients output and switch-client the right one.
const livePtyPids = new Set();

function tmuxArgs() {
  try {
    execSync(`tmux -L ${tmuxSocket} has-session`, { stdio: "ignore" });
    return ["-L", tmuxSocket, "attach"];
  } catch {
    return ["-L", tmuxSocket, "new-session", "-s", "main"];
  }
}

function handleConnection(ws) {
  const ptyProcess = pty.spawn("tmux", tmuxArgs(), {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env,
  });

  livePtyPids.add(ptyProcess.pid);

  ptyProcess.onData((data) => {
    if (ws.readyState === 1) ws.send(data);
  });

  ptyProcess.onExit(() => {
    livePtyPids.delete(ptyProcess.pid);
    if (ws.readyState === 1) ws.close();
  });

  ws.on("message", (msg) => {
    const input = typeof msg === "string" ? msg : msg.toString("utf-8");

    if (input.startsWith("\x1b[RESIZE:")) {
      const match = input.match(/\x1b\[RESIZE:(\d+);(\d+)\]/);
      if (match) {
        ptyProcess.resize(parseInt(match[1], 10), parseInt(match[2], 10));
        return;
      }
    }

    ptyProcess.write(input);
  });

  ws.on("close", () => {
    livePtyPids.delete(ptyProcess.pid);
    ptyProcess.kill();
  });
}

/**
 * Switch every live wterm pty's tmux client to the given target. Returns
 * the number of clients switched. The parent server hits this when the
 * voice target changes so the wterm view follows.
 */
function switchAllClientsTo(target) {
  if (livePtyPids.size === 0) return { switched: 0, reason: "no live ptys" };
  let listing = "";
  try {
    listing = execFileSync(
      "tmux",
      ["-L", tmuxSocket, "list-clients", "-F", "#{client_pid} #{client_name}"],
      { encoding: "utf8", timeout: 2000 },
    );
  } catch (err) {
    return { switched: 0, error: `tmux list-clients failed: ${err.message}` };
  }
  const names = [];
  for (const line of listing.trim().split("\n")) {
    const [pidStr, ...rest] = line.split(" ");
    const pid = parseInt(pidStr, 10);
    if (livePtyPids.has(pid)) names.push(rest.join(" "));
  }
  if (names.length === 0) {
    return { switched: 0, reason: "no tmux client matched live ptys" };
  }
  let switched = 0;
  for (const name of names) {
    try {
      execFileSync(
        "tmux",
        ["-L", tmuxSocket, "switch-client", "-c", name, "-t", target],
        { stdio: "ignore", timeout: 2000 },
      );
      switched++;
    } catch {
      // best-effort
    }
  }
  return { switched, total: names.length };
}

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(indexHtml);
  } else if (req.url === "/client.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(clientJs);
  } else if (req.url === "/terminal.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end(terminalCss);
  } else if (req.url === "/_clients") {
    // Internal: the Bun server uses this to correlate pty PIDs with tmux
    // clients. Bound to 127.0.0.1-ish via the same listen, so on a public
    // host this would need auth. Tailscale-only deployment is the assumption.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ptyPids: Array.from(livePtyPids) }));
  } else if (req.url === "/_switch" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let target = "";
      try {
        target = JSON.parse(body || "{}").target ?? "";
      } catch {
        // ignore
      }
      if (!target) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "target required" }));
        return;
      }
      const result = switchAllClientsTo(target);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, handleConnection);
  } else {
    socket.destroy();
  }
});

server.listen(port, host, () => {
  console.log(
    `wterm serving tmux socket '${tmuxSocket}' on http://${host}:${port}`,
  );
});
