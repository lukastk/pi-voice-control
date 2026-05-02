/**
 * Move the current wterm client to a Pi session's pane so the terminal view
 * follows the voice target.
 *
 * Single-client assumption: `tmux switch-client` without -c switches the most
 * recently active client. Phase 3 accepts that. Multi-tab pinning will need
 * tracking client_pid from `tmux list-clients` and passing -c explicitly;
 * deferred to a later phase.
 */
import { execFileSync } from "node:child_process";
import type { PiSession } from "../sessions/types.ts";

export function targetForSession(s: PiSession): string | null {
  if (!s.tmux.inTmux || !s.tmux.session) return null;
  if (s.tmux.windowIndex == null || s.tmux.paneIndex == null) return null;
  return `${s.tmux.session}:${s.tmux.windowIndex}.${s.tmux.paneIndex}`;
}

export function switchClientTo(tmuxSocketName: string, target: string): boolean {
  try {
    execFileSync("tmux", ["-L", tmuxSocketName, "switch-client", "-t", target], {
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch (err) {
    console.error(`[tmux] switch-client -t ${target} failed:`, (err as Error).message);
    return false;
  }
}
