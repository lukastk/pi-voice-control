/**
 * In-process pub/sub for SSE fan-out. Single user, single Bun process —
 * no need for Redis or anything cross-process.
 */
export type ServerEvent =
  | { type: "sessions:update"; data: unknown }
  | { type: "config:updated"; data: unknown }
  | { type: "voice:state"; data: unknown }
  | { type: "term:pin"; data: { pinned: boolean } }
  | { type: "prompt:updated"; data: { path: string; body: string; mtime: number } }
  | { type: "error"; data: { code: string; message: string } };

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function publish(event: ServerEvent): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch (err) {
      console.error("[bus] listener threw:", err);
    }
  }
}
