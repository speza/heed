import type { Agent, AgentStatus } from "../types";
import type { RuntimeAgent, RuntimeStatus } from "./types";

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

export function runtimeAgent(agent: RuntimeAgent): Agent {
  const title = agent.terminalTitle?.trim();
  const location = agent.location;
  const workspace = location?.workspaceLabel ?? location?.cwd ?? location?.workspaceId;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.kind,
    task: title && title !== agent.name ? title : location?.cwd ?? `Live ${agent.source.label} agent`,
    status: runtimeStatus(agent.status),
    provider: agent.provider ?? agent.source.label,
    model: agent.model ?? "Unavailable",
    workspace,
    elapsed: "live",
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
      ...(agent.openIn ? { openIn: agent.openIn } : {}),
      revision: agent.revision,
      interactiveReady: agent.interactiveReady,
      rawStatus: agent.status,
    },
  };
}
