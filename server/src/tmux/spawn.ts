/**
 * Spawn a fresh Pi session in a configured tmux session/window.
 *
 * Strategy:
 *   1. Snapshot the current set of *.sock files.
 *   2. tmux -L <socketName> has-session -t <spawnSession>; if not, new-session -d.
 *   3. tmux new-window -t <spawnSession> -c <folder> 'pi'.
 *   4. Poll the socket dir up to timeoutMs for a new file; return its path.
 *
 * Errors propagate. Caller decides whether to surface to UI or fall back.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

export type SpawnOptions = {
  tmuxSocketName: string;
  spawnTmuxSession: string;
  socketsDir: string;
  folder: string;
  piCommand?: string; // override; default "pi"
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
  const piCmd = opts.piCommand ?? "pi";
  const timeoutMs = opts.timeoutMs ?? 30000;

  const before = new Set(listSockets(opts.socketsDir));

  ensureTmuxSession(opts.tmuxSocketName, opts.spawnTmuxSession, opts.folder);

  const windowName = makeWindowName(opts.folder);

  // Spawn the new window with a distinctive name so multiple Pi sessions in
  // the same folder are tellable apart in the picker UI and tmux's window
  // list (instead of all showing up as the default command name like "node").
  execFileSync(
    "tmux",
    [
      "-L",
      opts.tmuxSocketName,
      "new-window",
      "-t",
      opts.spawnTmuxSession,
      "-c",
      opts.folder,
      "-n",
      windowName,
      piCmd,
    ],
    { stdio: "ignore", timeout: 5000 },
  );

  // Wait for a new socket to appear.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = listSockets(opts.socketsDir);
    for (const path of current) {
      if (!before.has(path)) {
        return path;
      }
    }
    await sleep(500);
  }

  throw new Error(
    `timed out waiting for new Pi socket after ${timeoutMs}ms — did pi launch in tmux?`,
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
