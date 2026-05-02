/**
 * Single-user, single-active-target state.
 */
export type VoiceTarget = {
  socketPath: string;
  roomName: string;
  dispatchId: string;
  startedAt: number;
};

let current: VoiceTarget | null = null;
let pinned = false;

export function getCurrentTarget(): VoiceTarget | null {
  return current;
}

export function setCurrentTarget(t: VoiceTarget | null) {
  current = t;
}

/**
 * When pinned, the wterm view stops following voice-target switches.
 * The user explicitly toggles this from the Terminal tab.
 */
export function getPinned(): boolean {
  return pinned;
}

export function setPinned(p: boolean) {
  pinned = p;
}
