/**
 * Switch the wterm view to a Pi session's pane. Goes through the wterm
 * subprocess's /_switch endpoint, which knows the pty PIDs of every live
 * wterm WebSocket client and can issue `tmux switch-client -c <name>` for
 * each one — fixing the multi-client / wrong-tab problem of plain
 * `tmux switch-client` (which just switches the most-recently-active
 * client).
 */
import type { PiSession } from "../sessions/types.ts";

const WTERM_PORT = Number(process.env.WTERM_PORT ?? 7891);

export function targetForSession(s: PiSession): string | null {
  if (!s.tmux.inTmux || !s.tmux.session) return null;
  if (s.tmux.windowIndex == null || s.tmux.paneIndex == null) return null;
  return `${s.tmux.session}:${s.tmux.windowIndex}.${s.tmux.paneIndex}`;
}

export async function switchClientTo(target: string): Promise<{
  switched: number;
  total?: number;
  error?: string;
  reason?: string;
}> {
  try {
    const res = await fetch(`http://127.0.0.1:${WTERM_PORT}/_switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { switched: 0, error: `wterm /_switch ${res.status}` };
    }
    return (await res.json()) as { switched: number; total?: number };
  } catch (err) {
    return { switched: 0, error: (err as Error).message };
  }
}
