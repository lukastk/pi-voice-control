/**
 * Filesystem-driven Pi-session discovery.
 *
 * Loop:
 *   1. readdir(socketsDir) → *.sock files.
 *   2. For each file, getRpcState (which doubles as a liveness probe).
 *   3. Stale rule: if the file exists but two consecutive probes fail and the
 *      file mtime is older than staleSocketAfterMs, unlink it.
 *   4. Build a snapshot, diff against the previous one, publish on change.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { getRpcState } from "./socket-client.ts";
import type { PiSession } from "./types.ts";
import { publish } from "../events/bus.ts";
import { getConfig } from "../config/store.ts";

let snapshot: PiSession[] = [];
let timer: NodeJS.Timeout | null = null;
const failureCounts = new Map<string, number>();

export function getSessionsSnapshot(): PiSession[] {
  return snapshot;
}

export function startPoller() {
  const cfg = getConfig();
  scheduleTick(cfg.pi.pollIntervalMs);
  // Immediate first tick.
  void tick();
}

export function stopPoller() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function pollOnce(): Promise<PiSession[]> {
  return await tick();
}

function scheduleTick(intervalMs: number) {
  timer = setTimeout(async () => {
    await tick();
    scheduleTick(intervalMs);
  }, intervalMs);
}

async function tick(): Promise<PiSession[]> {
  const cfg = getConfig();
  const dir = cfg.pi.socketsDir;
  const staleAfterMs = cfg.pi.staleSocketAfterMs;
  const now = Date.now();

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sock"));
  } catch {
    files = [];
  }

  const next: PiSession[] = [];

  for (const file of files) {
    const socketPath = join(dir, file);
    const sessionId = basename(file, ".sock");
    const state = await getRpcState(socketPath);

    if (state) {
      failureCounts.delete(socketPath);
      next.push({
        socketPath,
        sessionId,
        alive: true,
        lastSeen: now,
        cwd: typeof state.cwd === "string" ? state.cwd : null,
        state: {
          idle: state.idle,
          contextUsage: state.contextUsage ?? null,
          hasAppendedSystemPrompt: state.hasAppendedSystemPrompt ?? false,
        },
        tmux: state.tmux ?? { inTmux: false },
      });
    } else {
      const fails = (failureCounts.get(socketPath) ?? 0) + 1;
      failureCounts.set(socketPath, fails);

      // Stale cleanup: ≥2 failed probes and file mtime older than threshold.
      if (fails >= 2) {
        try {
          const st = statSync(socketPath);
          if (now - st.mtimeMs > staleAfterMs) {
            unlinkSync(socketPath);
            failureCounts.delete(socketPath);
            console.log(`[poller] removed stale socket ${socketPath}`);
            continue;
          }
        } catch {
          // file vanished — fine
        }
      }
    }
  }

  // Drop failureCounts entries for files that no longer exist.
  for (const path of failureCounts.keys()) {
    if (!files.some((f) => join(dir, f) === path)) {
      failureCounts.delete(path);
    }
  }

  if (!shallowEqualSessions(snapshot, next)) {
    snapshot = next;
    publish({ type: "sessions:update", data: snapshot });
  }
  return next;
}

function shallowEqualSessions(a: PiSession[], b: PiSession[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x.sessionId.localeCompare(y.sessionId));
  const sortedB = [...b].sort((x, y) => x.sessionId.localeCompare(y.sessionId));
  for (let i = 0; i < sortedA.length; i++) {
    const x = sortedA[i]!;
    const y = sortedB[i]!;
    if (
      x.sessionId !== y.sessionId ||
      x.cwd !== y.cwd ||
      x.state.idle !== y.state.idle ||
      x.state.contextUsage !== y.state.contextUsage ||
      x.state.hasAppendedSystemPrompt !== y.state.hasAppendedSystemPrompt ||
      x.tmux.session !== y.tmux.session ||
      x.tmux.window !== y.tmux.window ||
      x.tmux.paneId !== y.tmux.paneId
    ) {
      return false;
    }
  }
  return true;
}
