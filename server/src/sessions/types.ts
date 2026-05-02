/**
 * What we know about a Pi rpc-socket session, as exposed to the UI.
 */
export type ContextUsage = {
  tokens: number;
  contextWindow: number;
  percent: number;
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
};
