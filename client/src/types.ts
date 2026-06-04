export type ContextUsage = {
  tokens: number;
  contextWindow: number;
  percent: number;
};

// Metadata from the user's `sesh` session manager, present only for
// sesh-registered sessions (joined by sessionId === sesh uuid).
export type SeshMeta = {
  uuid: string;
  name: string;
  tags: string[];
  turnStatus: string;
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
