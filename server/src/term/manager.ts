/**
 * Spawn the wterm Node subprocess that exposes a tmux pty over WebSocket.
 *
 * Why a subprocess: node-pty doesn't deliver data events under Bun 1.3 on
 * macOS (libuv compat issue), so the pty layer has to run on Node. The
 * Bun server stays the single source of truth for config and ownership;
 * it's the parent process and tears the child down on exit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

let child: ChildProcess | null = null;

export function startWterm(opts: {
  repoRoot: string;
  port: number;
  tmuxSocketName: string;
}): void {
  if (child) {
    console.warn("[wterm] already running, skipping spawn");
    return;
  }

  const wtermDir = join(opts.repoRoot, "wterm");
  console.log(`[wterm] spawning on port ${opts.port} (tmux -L ${opts.tmuxSocketName})`);

  child = spawn(
    "node",
    ["--preserve-symlinks", "--preserve-symlinks-main", "server.mjs"],
    {
      cwd: wtermDir,
      env: {
        ...process.env,
        WTERM_PORT: String(opts.port),
        TMUX_SOCKET: opts.tmuxSocketName,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  child.on("exit", (code, signal) => {
    console.log(`[wterm] exited code=${code} signal=${signal}`);
    child = null;
  });

  // On parent exit, kill the child.
  const onShutdown = () => {
    if (child) {
      child.kill();
      child = null;
    }
  };
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);
  process.once("exit", onShutdown);
}

export function stopWterm() {
  if (child) {
    child.kill();
    child = null;
  }
}
