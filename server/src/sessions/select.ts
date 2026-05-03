/**
 * Folder-based selection helpers.
 */
import { realpathSync } from "node:fs";
import type { PiSession } from "./types.ts";
import { expandTilde } from "../util/path.ts";

/**
 * Compare two filesystem paths after tilde-expanding and realpath-ing both.
 * Returns false if either path can't be resolved (e.g. the cwd no longer
 * exists).
 */
export function sameFolder(a: string, b: string): boolean {
  try {
    return realpathSync(expandTilde(a)) === realpathSync(expandTilde(b));
  } catch {
    return false;
  }
}

/**
 * Pick the session whose cwd matches `folder`. If multiple match, prefer
 * the one with the largest lastSeen.
 */
export function findSessionByFolder(
  sessions: PiSession[],
  folder: string,
): PiSession | null {
  const matches = sessions.filter((s) => s.cwd && sameFolder(s.cwd, folder));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.lastSeen - a.lastSeen);
  return matches[0]!;
}
