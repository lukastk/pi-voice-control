/**
 * Send {appendSystemPrompt} or {clearSystemPrompt} to a Pi rpc-socket.
 *
 * One-shot connection: open, write, await ack ({ok:true,...}|{error:...}),
 * close. We don't subscribe — the worker owns the subscriber connection
 * for the active voice target.
 */
import * as net from "node:net";

export async function appendSystemPromptToSocket(
  socketPath: string,
  text: string,
  timeoutMs = 1500,
): Promise<{ ok: boolean; error?: string }> {
  return sendCommand(socketPath, { appendSystemPrompt: text }, timeoutMs);
}

export async function clearSystemPromptOnSocket(
  socketPath: string,
  timeoutMs = 1500,
): Promise<{ ok: boolean; error?: string }> {
  return sendCommand(socketPath, { clearSystemPrompt: true }, timeoutMs);
}

function sendCommand(
  socketPath: string,
  cmd: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    const conn = net.createConnection(socketPath);
    let buf = "";

    conn.on("connect", () => conn.write(JSON.stringify(cmd) + "\n"));
    conn.on("data", (data: Buffer) => {
      buf += data.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.error) {
            clearTimeout(timer);
            finish({ ok: false, error: String(parsed.error) });
            return;
          }
          if (parsed?.ok) {
            clearTimeout(timer);
            finish({ ok: true });
            return;
          }
        } catch {
          // skip non-JSON
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
  });
}
