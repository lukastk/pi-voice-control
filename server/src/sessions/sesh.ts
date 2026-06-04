/**
 * Optional integration with `sesh` (github.com/lukastk/sesh), the user's
 * cross-machine session manager. When present it gives our raw pi sockets a
 * human name, tags, and status, and is the canonical way to create a new pi
 * session.
 *
 * We shell out to its CLI rather than take a hard dependency: any failure
 * (binary not on PATH, daemon down) degrades cleanly — discovery falls back
 * to raw socket polling, and spawn falls back to launching `pi` directly.
 *
 * Join key (validated in _dev/experiments/00 + 01): a pi rpc socket is named
 * `<uuid>.sock`, and sesh stores that same uuid as `record.uuid`, so
 * `PiSession.sessionId === record.uuid`.
 *
 * Note: `bin` should generally be an ABSOLUTE path — under supervisord the
 * server's PATH does not include `~/go/bin` where `sesh` typically lives.
 */
import { execFile } from "node:child_process";
import type { SeshMeta } from "./types.ts";

type SeshRecord = {
  uuid: string;
  name?: string;
  machine?: string;
  cwd?: string;
  turnStatus?: string;
  contextPct?: number;
  tags?: string[];
  summary?: string;
};

let warnedUnavailable = false;

/**
 * Query sesh for pi sessions, returning a `uuid → metadata` map. On ANY
 * failure returns an empty map (logging once) so callers treat sesh as
 * best-effort enrichment rather than a dependency.
 */
export async function listPiSessions(bin: string): Promise<Map<string, SeshMeta>> {
  const out = new Map<string, SeshMeta>();
  let stdout: string;
  try {
    stdout = await execFileText(bin, ["list", "--agent", "pi", "--json"], 2500);
  } catch (err: any) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.log(
        `[sesh] enrichment unavailable (${err?.message ?? err}); using raw socket discovery`,
      );
    }
    return out;
  }
  warnedUnavailable = false;

  let records: SeshRecord[];
  try {
    records = JSON.parse(stdout) as SeshRecord[];
  } catch {
    return out;
  }
  for (const r of records ?? []) {
    if (!r || typeof r.uuid !== "string") continue;
    out.set(r.uuid, {
      uuid: r.uuid,
      name: typeof r.name === "string" ? r.name : "",
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      turnStatus: typeof r.turnStatus === "string" ? r.turnStatus : "unknown",
      summary: typeof r.summary === "string" ? r.summary : "",
      machine: typeof r.machine === "string" ? r.machine : "",
      contextPct: typeof r.contextPct === "number" ? r.contextPct : -1,
    });
  }
  return out;
}

/**
 * Register a new pi session with sesh from birth and get back the uuid and the
 * exact shell command to launch it (`mkdir -p cwd && cd cwd && … pi
 * --session-id <uuid>`). We run that launch ourselves (in our tmux window) so
 * we can wait for the deterministic `<uuid>.sock` and keep our own spawn
 * error-surfacing — `sesh new --target` launches but does not return the uuid.
 *
 * Throws on any sesh failure; the caller falls back to a bare `pi` spawn.
 */
export async function registerPiSession(opts: {
  bin: string;
  cwd: string;
  tags?: string[];
  name?: string;
}): Promise<{ uuid: string; launch: string }> {
  const args = ["new", "--agent", "pi", "--cwd", opts.cwd, "--no-launch", "--json"];
  for (const t of opts.tags ?? []) args.push("--tag", t);
  if (opts.name) args.push("--name", opts.name);

  const stdout = await execFileText(opts.bin, args, 8000);
  const parsed = JSON.parse(stdout) as { uuid?: string; launch?: string };
  if (!parsed.uuid || !parsed.launch) {
    throw new Error(`sesh new returned no uuid/launch: ${stdout.slice(0, 200)}`);
  }
  return { uuid: parsed.uuid, launch: parsed.launch };
}

function execFileText(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim().slice(0, 200);
          reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
