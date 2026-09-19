import type { RuntimeChanges, RuntimeOutput, RuntimeSnapshot, RuntimeTerminalMessage, RuntimeTerminalSession } from "./types";

const JSON_HEADERS = { "content-type": "application/json" } as const;

async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(value.error ?? `Runtime request failed (${response.status}).`);
  return value;
}

export async function fetchRuntime(signal?: AbortSignal): Promise<RuntimeSnapshot> {
  return responseJson(await fetch("/api/runtime", { cache: "no-store", signal }));
}

export async function fetchAgentOutput(id: string, signal?: AbortSignal): Promise<RuntimeOutput> {
  return responseJson(
    await fetch(`/api/runtime/agents/${encodeURIComponent(id)}/output?source=visible&format=ansi&lines=200`, {
      cache: "no-store",
      signal,
    }),
  );
}

export async function fetchAgentChanges(id: string, signal?: AbortSignal): Promise<RuntimeChanges> {
  return responseJson(
    await fetch(`/api/runtime/agents/${encodeURIComponent(id)}/changes`, {
      cache: "no-store",
      signal,
    }),
  );
}

export async function openAgentTerminal(id: string, columns: number, rows: number): Promise<RuntimeTerminalSession> {
  return responseJson(
    await fetch(`/api/runtime/agents/${encodeURIComponent(id)}/terminal`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ columns, rows }),
    }),
  );
}

export async function releaseAgentTerminal(sessionId: string): Promise<void> {
  await fetch(`/api/runtime/terminal/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
  });
}

export function agentTerminalSocketUrl(sessionId: string, afterDeliveryId?: number): string {
  const url = new URL(`/api/runtime/terminal/${encodeURIComponent(sessionId)}/socket`, window.location.href);
  if (afterDeliveryId !== undefined) url.searchParams.set("after", String(afterDeliveryId));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function parseTerminalMessage(value: string): RuntimeTerminalMessage {
  const parsed = JSON.parse(value) as RuntimeTerminalMessage;
  if (!parsed || !["frame", "closed", "error"].includes(parsed.kind)) throw new Error("Invalid terminal message.");
  return parsed;
}
