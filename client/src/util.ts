/**
 * Last segment of a path — the directory or filename. No platform-specific
 * separators since we only show this to the user.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
