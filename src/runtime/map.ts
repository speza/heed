import type { Agent, AgentStatus } from "../types";
import type { RuntimeAgent, RuntimeStatus } from "./types";

/** Compact relative duration: `now`, `42s`, `7m`, `3h`, `2d`. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Shortens a macOS or Linux home directory prefix to `~`. */
export function displayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, "~");
}

export function runtimeStatus(status: RuntimeStatus): AgentStatus {
  switch (status) {
    case "blocked":
      return "needs-you";
    case "idle":
      return "waiting";
    case "unknown":
      return "unknown";
    default:
      return status;
  }
}

export function runtimeAgent(agent: RuntimeAgent, now = Date.now()): Agent {
  const title = agent.terminalTitle?.trim();
  const location = agent.location;
  const cwd = location?.cwd ? displayPath(location.cwd) : undefined;
  const workspace = location?.workspaceLabel ?? cwd ?? location?.workspaceId;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.kind,
    task: title && title !== agent.name ? title : cwd ?? `Live ${agent.source.label} agent`,
    status: runtimeStatus(agent.status),
    provider: agent.provider ?? agent.source.label,
    model: agent.model ?? agent.kind,
    workspace,
    ...(agent.statusSince !== undefined ? { elapsed: formatDuration(now - agent.statusSince) } : {}),
    ...(agent.status === "blocked"
      ? { attention: "Waiting for input" }
      : agent.status === "done"
        ? { attention: "Turn complete" }
        : {}),
    messages: [],
    changes: [],
    runtime: {
      sourceId: agent.source.id,
      sourceLabel: agent.source.label,
      sourceKind: agent.source.kind,
      capabilities: agent.capabilities,
      ...(agent.sourceAvailable !== undefined ? { sourceAvailable: agent.sourceAvailable } : {}),
      ...(agent.sourceStale !== undefined ? { sourceStale: agent.sourceStale } : {}),
      location,
      revision: agent.revision,
      ...(agent.stateSequence !== undefined ? { stateSequence: agent.stateSequence } : {}),
      ...(agent.statusSince !== undefined ? { statusSince: agent.statusSince } : {}),
      interactiveReady: agent.interactiveReady,
      rawStatus: agent.status,
    },
  };
}
