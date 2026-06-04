/**
 * What we know about a Pi rpc-socket session, as exposed to the UI.
 */
export type ContextUsage = {
  tokens: number;
  contextWindow: number;
  percent: number;
};

/**
 * Metadata from the user's `sesh` session manager, joined onto a discovered
 * socket by `PiSession.sessionId === sesh record.uuid` (the rpc socket is
 * named `<uuid>.sock`). Present only for sesh-registered sessions; bare pi
 * sessions started outside sesh have no entry.
 */
export type SeshMeta = {
  uuid: string;
  name: string;
  tags: string[];
  turnStatus: string; // "idle" | "busy" | "unknown"
  summary: string;
  machine: string;
  contextPct: number;
};

export type PiSession = {
  socketPath: string;
  sessionId: string;
  alive: boolean;
  lastSeen: number;
  cwd: string | null;
  state: {
    idle: boolean;
    contextUsage: ContextUsage | null;
    hasAppendedSystemPrompt: boolean;
  };
  tmux: {
    inTmux: boolean;
    session?: string;
    window?: string;
    windowIndex?: number;
    paneIndex?: number;
    paneId?: string;
  };
  sesh?: SeshMeta;
};
