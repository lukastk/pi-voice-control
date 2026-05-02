/**
 * One-shot rpc-socket query: connect, send {getState:true}, await
 * {ok:true,state:{...}}, close. Used by the poller to take a snapshot.
 *
 * We do NOT subscribe to events here — that's the worker's job. This client
 * only does point-in-time state reads.
 */
import * as net from "node:net";

export type RpcState = {
  idle: boolean;
  contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
  hasAppendedSystemPrompt: boolean;
  cwd?: string;
  tmux: {
    inTmux: boolean;
    session?: string;
    window?: string;
    windowIndex?: number;
    paneIndex?: number;
    paneId?: string;
  };
};

export async function getRpcState(
  socketPath: string,
  timeoutMs = 1500,
): Promise<RpcState | null> {
  return new Promise<RpcState | null>((resolve) => {
    let settled = false;
    const finish = (result: RpcState | null) => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const conn = net.createConnection(socketPath);
    let buffer = "";

    conn.on("connect", () => {
      conn.write(JSON.stringify({ getState: true }) + "\n");
    });

    conn.on("data", (data: Buffer) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.ok === true && parsed.state) {
            clearTimeout(timer);
            finish(parsed.state as RpcState);
            return;
          }
          if (parsed?.error) {
            clearTimeout(timer);
            finish(null);
            return;
          }
        } catch {
          // skip non-JSON
        }
      }
    });

    conn.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/**
 * Liveness probe — same trick as the mockup: any successful TCP connect
 * counts as alive. Faster than getRpcState when we just want to know if
 * the file is a real socket vs. a stale leftover.
 */
export async function isSocketAlive(socketPath: string, timeoutMs = 800): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy();
      } catch {
        // ignore
      }
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const conn = net.createConnection(socketPath);
    conn.on("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    conn.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}
