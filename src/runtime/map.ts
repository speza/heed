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
  const location = agent.workspaceLabel ?? agent.cwd ?? agent.workspaceId;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.kind,
    task: title && title !== agent.name ? title : agent.cwd ?? "Live Herdr agent",
    status: runtimeStatus(agent.status),
    provider: "Herdr",
    model: agent.kind,
    workspace: location,
    elapsed: "live",
    ...(agent.status === "blocked"
      ? { attention: "Waiting for input" }
      : agent.status === "done"
        ? { attention: "Turn complete" }
        : {}),
    messages: [],
    changes: [],
    runtime: {
      paneId: agent.paneId,
      workspaceId: agent.workspaceId,
      tabId: agent.tabId,
      cwd: agent.cwd,
      revision: agent.revision,
      interactiveReady: agent.interactiveReady,
      rawStatus: agent.status,
    },
  };
}
