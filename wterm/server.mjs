import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const port = parseInt(process.env.WTERM_PORT, 10);
const tmuxSocket = process.env.TMUX_SOCKET;

if (isNaN(port))
  throw new Error("WTERM_PORT environment variable must be a valid port number");
if (!tmuxSocket)
  throw new Error("TMUX_SOCKET environment variable is required");

const host = "0.0.0.0";
const baseDir = process.cwd();

const indexHtml = readFileSync(join(baseDir, "index.html"), "utf-8");
const clientJs = readFileSync(join(baseDir, "dist/client.js"), "utf-8");
const terminalCss = readFileSync(
  join(baseDir, "node_modules/@wterm/dom/src/terminal.css"),
  "utf-8",
);

function tmuxArgs() {
  try {
    execSync(`tmux -L ${tmuxSocket} has-session`, { stdio: "ignore" });
    // Sessions exist — attach to the most recent one
    return ["-L", tmuxSocket, "attach"];
  } catch {
    // No sessions — create a new one
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

  ptyProcess.onData((data) => {
    if (ws.readyState === 1) ws.send(data);
  });

  ptyProcess.onExit(() => {
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
    ptyProcess.kill();
  });
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
