import { homedir } from "node:os";

/**
 * Expand a leading ~ or ~/ to the home directory. Other path forms are
 * returned untouched.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}
