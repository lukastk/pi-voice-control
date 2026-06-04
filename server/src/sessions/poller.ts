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
import { listPiSessions } from "./sesh.ts";
import type { PiSession } from "./types.ts";
import { publish } from "../events/bus.ts";
import { getConfig } from "../config/store.ts";
import { getCurrentTarget, setCurrentTarget } from "../state.ts";
import { deleteDispatch } from "../livekit.ts";

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

  // Best-effort enrichment: join sesh metadata (name/tags/status) onto each
  // discovered socket by sessionId === sesh uuid. Sockets started outside
  // sesh simply won't match and keep their raw display. listPiSessions never
  // throws — it returns an empty map if sesh is unavailable.
  if (cfg.sesh.enabled && next.length > 0) {
    const meta = await listPiSessions(cfg.sesh.bin);
    if (meta.size > 0) {
      for (const s of next) {
        const m = meta.get(s.sessionId);
        if (m) s.sesh = m;
      }
    }
  }

  if (!shallowEqualSessions(snapshot, next)) {
    snapshot = next;
    publish({ type: "sessions:update", data: snapshot });
  }

  // If the current voice target's socket has disappeared, the Pi session
  // ended (user closed it, /reload, crash). Release the dispatch so the UI
  // knows it's gone instead of staying connected to a phantom room.
  const target = getCurrentTarget();
  if (target && !next.some((s) => s.socketPath === target.socketPath)) {
    console.log(`[poller] voice target gone: ${target.socketPath} — releasing`);
    setCurrentTarget(null);
    void deleteDispatch(target.roomName, target.dispatchId);
    publish({
      type: "voice:state",
      data: { state: "target-lost", socketPath: target.socketPath },
    });
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
      x.tmux.paneId !== y.tmux.paneId ||
      x.sesh?.name !== y.sesh?.name ||
      x.sesh?.turnStatus !== y.sesh?.turnStatus ||
      x.sesh?.summary !== y.sesh?.summary ||
      (x.sesh?.tags?.join(",") ?? "") !== (y.sesh?.tags?.join(",") ?? "")
    ) {
      return false;
    }
  }
  return true;
}
