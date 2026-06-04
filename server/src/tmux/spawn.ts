/**
 * Spawn a fresh Pi session in a configured tmux session/window.
 *
 * Strategy:
 *   1. Snapshot the current set of *.sock files.
 *   2. tmux -L <socketName> has-session -t <spawnSession>; if not, new-session -d.
 *   3. tmux new-window -t <spawnSession> -c <folder> 'pi', capturing its
 *      window id and pinning remain-on-exit so the pane survives if pi dies.
 *   4. Poll the socket dir up to timeoutMs for a new file; return its path.
 *      If pi exits before a socket appears, capture the pane and surface
 *      pi's own error instead of a generic timeout (e.g. a broken pi
 *      extension that aborts startup → no rpc socket is ever created).
 *
 * Errors propagate. Caller decides whether to surface to UI or fall back.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export type SpawnOptions = {
  tmuxSocketName: string;
  spawnTmuxSession: string;
  socketsDir: string;
  folder: string;
  // Command to run in the new window. Defaults to "pi" (a bare launch). When
  // spawning through sesh this is the `launch` shell string sesh returns
  // (`mkdir -p … && cd … && pi --session-id <uuid>`), run via the shell.
  command?: string;
  // When known up-front (the sesh path), wait for this exact `<id>.sock`
  // instead of diffing the whole sockets dir — deterministic, race-free.
  expectSocketBasename?: string;
  timeoutMs?: number; // default 30000
};

function makeWindowName(folder: string): string {
  // <folder-basename>-<HHMM> — folder gives context, time disambiguates
  // multiple windows in the same folder so they don't collide in the tmux
  // window list and the user can tell them apart in the picker.
  const base = basename(folder.replace(/\/+$/, "")) || "pi";
  const safe = base.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 24);
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  return `${safe}-${hhmm}`;
}

export async function spawnPiInFolder(opts: SpawnOptions): Promise<string> {
  const cmd = opts.command ?? "pi";
  const timeoutMs = opts.timeoutMs ?? 30000;
  const sock = opts.tmuxSocketName;
  const expectPath = opts.expectSocketBasename
    ? join(opts.socketsDir, `${opts.expectSocketBasename}.sock`)
    : null;

  const before = new Set(listSockets(opts.socketsDir));

  ensureTmuxSession(sock, opts.spawnTmuxSession, opts.folder);

  const windowName = makeWindowName(opts.folder);

  // Spawn the new window with a distinctive name so multiple Pi sessions in
  // the same folder are tellable apart in the picker UI and tmux's window
  // list (instead of all showing up as the default command name like "node").
  // -P -F captures the window id so we can target it precisely afterwards
  // even if names collide.
  const windowId = execFileSync(
    "tmux",
    [
      "-L",
      sock,
      "new-window",
      "-t",
      opts.spawnTmuxSession,
      "-c",
      opts.folder,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{window_id}",
      cmd,
    ],
    { encoding: "utf8", timeout: 5000 },
  ).trim();

  // Pin remain-on-exit ON for just this window so that if pi exits (e.g. a
  // broken extension aborts startup) the pane stays dead-but-readable instead
  // of tmux closing the window and discarding pi's error. Scoped to this
  // window id — no effect on the user's other windows. There's a tiny race if
  // pi dies in <~ms before this runs; that's handled by the "window gone"
  // branch below.
  setRemainOnExit(sock, windowId, true);

  // Wait for the socket to appear, watching for early pi death.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Deterministic path (sesh): wait for the specific <uuid>.sock.
    // Fallback path (bare pi): take the first socket not present before.
    if (expectPath) {
      if (existsSync(expectPath)) {
        setRemainOnExit(sock, windowId, false);
        return expectPath;
      }
    } else {
      const current = listSockets(opts.socketsDir);
      for (const path of current) {
        if (!before.has(path)) {
          // Success: pi is up. Restore normal exit behavior for this window so
          // it closes cleanly when the user later quits pi.
          setRemainOnExit(sock, windowId, false);
          return path;
        }
      }
    }
    // pi exited before producing a socket — surface its actual output.
    const pane = paneStatus(sock, windowId);
    if (pane.gone || pane.dead) {
      const output = pane.gone ? "" : capturePane(sock, windowId);
      killWindow(sock, windowId);
      const detail = output
        ? ` — pi exited before creating a socket. Last output:\n${output}`
        : " — pi exited immediately (window closed) before creating a socket; likely a pi startup/extension error. Run `pi` manually in tmux to see it.";
      throw new Error(`pi failed to start${detail}`);
    }
    await sleep(500);
  }

  // Timed out with pi still running but no socket — the rpc-socket extension
  // never registered. Leave the window up (pi is usable) but say so clearly.
  setRemainOnExit(sock, windowId, false);
  const alive = !paneStatus(sock, windowId).gone;
  throw new Error(
    alive
      ? `timed out after ${timeoutMs}ms: pi is running but never created an rpc socket in ${opts.socketsDir} — is the rpc-socket pi extension installed and enabled?`
      : `timed out waiting for new Pi socket after ${timeoutMs}ms — did pi launch in tmux?`,
  );
}

function ensureTmuxSession(socketName: string, sessionName: string, cwd: string): void {
  try {
    execFileSync("tmux", ["-L", socketName, "has-session", "-t", sessionName], {
      stdio: "ignore",
      timeout: 2000,
    });
    return; // already exists
  } catch {
    // missing — create a detached, holding session in `cwd`.
    execFileSync(
      "tmux",
      ["-L", socketName, "new-session", "-d", "-s", sessionName, "-c", cwd],
      { stdio: "ignore", timeout: 5000 },
    );
  }
}

function setRemainOnExit(sock: string, windowId: string, on: boolean): void {
  try {
    execFileSync(
      "tmux",
      ["-L", sock, "set-option", "-w", "-t", windowId, "remain-on-exit", on ? "on" : "off"],
      { stdio: "ignore", timeout: 2000 },
    );
  } catch {
    // window may already be gone, or the option unsupported — non-fatal.
  }
}

/** Whether the window's pane is gone (window closed) or dead (process exited
 *  but pane retained via remain-on-exit). */
function paneStatus(sock: string, windowId: string): { gone: boolean; dead: boolean } {
  try {
    const out = execFileSync(
      "tmux",
      ["-L", sock, "list-panes", "-t", windowId, "-F", "#{pane_dead}"],
      { encoding: "utf8", timeout: 2000 },
    );
    return { gone: false, dead: out.trim().split(/\s+/).some((v) => v === "1") };
  } catch {
    // list-panes errors when the window no longer exists.
    return { gone: true, dead: false };
  }
}

function capturePane(sock: string, windowId: string): string {
  try {
    const out = execFileSync(
      "tmux",
      ["-L", sock, "capture-pane", "-p", "-t", windowId],
      { encoding: "utf8", timeout: 2000 },
    );
    // Keep the last handful of non-empty lines — pi's error sits at the
    // bottom, and the TUI leaves lots of blank padding above it.
    return out
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0)
      .slice(-12)
      .join("\n");
  } catch {
    return "";
  }
}

function killWindow(sock: string, windowId: string): void {
  try {
    execFileSync("tmux", ["-L", sock, "kill-window", "-t", windowId], {
      stdio: "ignore",
      timeout: 2000,
    });
  } catch {
    // already gone — fine.
  }
}

function listSockets(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sock"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
