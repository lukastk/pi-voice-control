import * as net from "node:net";
import { existsSync } from "node:fs";

export type PiCallbacks = {
  onTextDelta: (delta: string) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string) => void;
  onAgentEnd?: () => void;
};

export class SteeredError extends Error {
  constructor() {
    super("Steered");
    this.name = "SteeredError";
  }
}

/**
 * Thrown when the Pi process has clearly ended (socket file is gone or the
 * connection cannot be reopened). llmNode reads the name to surface a
 * helpful spoken message instead of the generic "Sorry…" fallback.
 */
export class PiSessionEndedError extends Error {
  constructor(message = "Pi session has ended") {
    super(message);
    this.name = "PiSessionEndedError";
  }
}

/**
 * One connection to a Pi rpc-socket extension Unix socket.
 *
 * Survives the rpc-socket connection going away mid-session: on close, we
 * reconnect transparently before the next prompt(). This matters because
 * Pi can /reload or briefly hiccup, and we don't want every voice turn
 * after that to fall back to "Sorry, I had trouble with that."
 */
export class PiSocket {
  private conn: net.Socket | null = null;
  private buffer = "";
  private connected = false;
  private busy = false;
  private eventHandler: ((event: any) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;
  private appendedSystemPrompt: string | null = null;
  private closed = false;

  public currentPromptText: string | null = null;

  constructor(private readonly socketPath: string) {}

  connect(): Promise<void> {
    return this.openConnection();
  }

  private openConnection(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("PiSocket already closed by caller"));
    }
    return new Promise((resolve, reject) => {
      this.conn = net.createConnection(this.socketPath, () => {
        this.connected = true;
        // Re-establish event subscription on (re)connect.
        this.sendRaw({ subscribe: true });
        // Re-inject the system prompt if the caller previously set one,
        // since rpc-socket only persists it within the live process.
        if (this.appendedSystemPrompt !== null) {
          this.sendRaw({ appendSystemPrompt: this.appendedSystemPrompt });
        }
        resolve();
      });
      this.conn.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });
      this.conn.on("error", (err) => {
        this.connected = false;
        // Only reject the initial connect; later errors surface via close.
        reject(err);
      });
      this.conn.on("close", () => {
        this.connected = false;
        // If we had an in-flight prompt, reject it so the LLM stream can
        // complete (with "Sorry…" fallback) instead of hanging.
        if (this.currentReject) {
          this.currentReject(new Error("PiSocket connection lost"));
          this.currentReject = null;
          this.busy = false;
          this.eventHandler = null;
          this.currentPromptText = null;
        }
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.closed) throw new Error("PiSocket already closed by caller");
    // If the Unix socket file is gone, Pi exited — don't try to reconnect.
    // Surface a specific error so the agent can speak a clear message.
    if (!existsSync(this.socketPath)) {
      throw new PiSessionEndedError();
    }
    try {
      await this.openConnection();
    } catch (err) {
      // ECONNREFUSED on a still-existing file usually means Pi crashed
      // recently and left a stale socket — still treat as session ended.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        throw new PiSessionEndedError();
      }
      throw err;
    }
  }

  get isBusy() {
    return this.busy;
  }

  private processBuffer() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        this.handleParsed(parsed);
      } catch {
        // Non-JSON line — ignore.
      }
    }
  }

  private handleParsed(parsed: any) {
    if (parsed?.ok !== undefined || parsed?.error !== undefined) return;
    if (!this.eventHandler) return;
    const e = parsed?.event;
    if (e === "text_delta") {
      this.eventHandler({ type: "text_delta", delta: parsed.delta ?? "" });
    } else if (e === "tool_execution_start") {
      this.eventHandler({ type: "tool_execution_start", toolName: parsed.toolName });
    } else if (e === "tool_execution_end") {
      this.eventHandler({ type: "tool_execution_end", toolName: parsed.toolName });
    } else if (e === "agent_end") {
      this.eventHandler({ type: "agent_end" });
    }
  }

  private sendRaw(data: Record<string, unknown>) {
    if (!this.conn || !this.connected) {
      throw new Error("PiSocket not connected");
    }
    this.conn.write(JSON.stringify(data) + "\n");
  }

  appendSystemPrompt(text: string) {
    this.appendedSystemPrompt = text;
    if (this.connected) this.sendRaw({ appendSystemPrompt: text });
  }

  clearSystemPrompt() {
    this.appendedSystemPrompt = null;
    if (this.connected) this.sendRaw({ clearSystemPrompt: true });
  }

  abort() {
    if (this.connected) this.sendRaw({ abort: true });
  }

  abandonCurrentPrompt() {
    if (this.currentReject) {
      this.currentReject(new SteeredError());
      this.currentReject = null;
    }
    // Important: clear the event handler too. Otherwise Pi continues to
    // emit text_delta / agent_end for the abandoned turn, the (stale)
    // handler routes them to a closed controller, and the next prompt's
    // accounting gets corrupted.
    this.eventHandler = null;
    // Don't flip busy=false — Pi is still finishing the abandoned turn
    // server-side. The next prompt() call will reuse the connection and
    // overwrite eventHandler when its response starts.
  }

  /**
   * Send a user message. Reconnects transparently if the underlying socket
   * has dropped. The rpc-socket extension delivers everything as steer —
   * idle Pi starts a new turn; busy Pi queues until tool calls finish.
   */
  async prompt(
    text: string,
    callbacks: PiCallbacks,
    isInterruption: boolean,
  ): Promise<void> {
    const isDuplicate = isInterruption && text === this.currentPromptText;

    await this.ensureConnected();

    this.busy = true;
    this.currentPromptText = text;

    return new Promise<void>((resolve, reject) => {
      this.currentReject = reject;
      this.eventHandler = (event) => {
        if (event.type === "text_delta") {
          callbacks.onTextDelta(event.delta || "");
        } else if (event.type === "tool_execution_start") {
          callbacks.onToolStart?.(event.toolName || "tool");
        } else if (event.type === "tool_execution_end") {
          callbacks.onToolEnd?.(event.toolName || "tool");
        } else if (event.type === "agent_end") {
          this.busy = false;
          this.eventHandler = null;
          this.currentReject = null;
          this.currentPromptText = null;
          callbacks.onAgentEnd?.();
          resolve();
        }
      };

      if (!isDuplicate) {
        try {
          this.sendRaw({ message: text });
        } catch (err) {
          this.busy = false;
          this.eventHandler = null;
          this.currentReject = null;
          this.currentPromptText = null;
          reject(err as Error);
        }
      }
    });
  }

  close() {
    this.closed = true;
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
  }
}
