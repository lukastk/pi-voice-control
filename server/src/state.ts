/**
 * Single-user, single-active-target state. Multi-session support is a later
 * phase concern; for now Phase 1 only tracks one voice target at a time.
 */
export type VoiceTarget = {
  socketPath: string;
  roomName: string;
  dispatchId: string;
  startedAt: number;
};

let current: VoiceTarget | null = null;

export function getCurrentTarget(): VoiceTarget | null {
  return current;
}

export function setCurrentTarget(t: VoiceTarget | null) {
  current = t;
}
