import * as net from "node:net";

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
 * One connection to a Pi rpc-socket extension Unix socket.
 *
 * Protocol (rpc-socket extension, single dialect):
 *   Outgoing JSONL commands:
 *     {"subscribe": true}
 *     {"message": "..."}                  (always delivered as steer internally)
 *     {"abort": true}
 *     {"appendSystemPrompt": "..."}
 *     {"clearSystemPrompt": true}
 *     {"getState": true}
 *
 *   Incoming JSONL events (subscribers only, socket-initiated turns only):
 *     {"event": "text_delta",            "delta": "..."}
 *     {"event": "tool_execution_start",  "toolName": "..."}
 *     {"event": "tool_execution_end",    "toolName": "..."}
 *     {"event": "agent_end"}
 *
 *   Plus ack lines like {"ok": true, ...} or {"error": "..."} which we ignore.
 */
export class PiSocket {
  private conn: net.Socket | null = null;
  private buffer = "";
  private connected = false;
  private busy = false;
  private eventHandler: ((event: any) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;

  public currentPromptText: string | null = null;

  constructor(private readonly socketPath: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn = net.createConnection(this.socketPath, () => {
        this.connected = true;
        this.sendRaw({ subscribe: true });
        resolve();
      });
      this.conn.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });
      this.conn.on("error", (err) => {
        this.connected = false;
        reject(err);
      });
      this.conn.on("close", () => {
        this.connected = false;
      });
    });
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
    // Acks: {ok:true,...} or {error:"..."}. Nothing to do; the protocol has no
    // correlation IDs and we don't await acks.
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
    this.sendRaw({ appendSystemPrompt: text });
  }

  clearSystemPrompt() {
    this.sendRaw({ clearSystemPrompt: true });
  }

  abort() {
    if (this.connected) this.sendRaw({ abort: true });
  }

  abandonCurrentPrompt() {
    if (this.currentReject) {
      this.currentReject(new SteeredError());
      this.currentReject = null;
    }
  }

  /**
   * Send a user message. The rpc-socket extension delivers everything as
   * deliverAs:"steer" — if Pi is idle the message starts a new turn; if busy,
   * it queues until the current tool calls finish.
   *
   * `isInterruption` lets the caller distinguish "user spoke again while Pi
   * was talking" (steer) from "fresh turn" (prompt). The wire send is the
   * same; the flag only controls the duplicate-guard so LiveKit retrying
   * llmNode for the same chat-context doesn't double-send.
   */
  prompt(
    text: string,
    callbacks: PiCallbacks,
    isInterruption: boolean,
  ): Promise<void> {
    const isDuplicate = isInterruption && text === this.currentPromptText;

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
        this.sendRaw({ message: text });
      }
    });
  }

  close() {
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
  }
}
