export type DispatchResult = {
  roomName: string;
  token: string;
  livekitUrl: string;
  dispatchId: string;
};

export async function selectSession(socketPath: string): Promise<DispatchResult> {
  const res = await fetch("/api/sessions/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ socketPath }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`select failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DispatchResult;
}

export async function releaseSession(): Promise<void> {
  await fetch("/api/sessions/release", { method: "POST" });
}

export async function fetchHealth(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/health");
  return await res.json();
}
