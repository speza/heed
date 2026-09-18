import { describe, expect, test } from "vitest";
import { runtimeAgent, runtimeStatus } from "./map";

describe("runtime mapping", () => {
  test("maps blocked and idle states without inventing failure", () => {
    expect(runtimeStatus("blocked")).toBe("needs-you");
    expect(runtimeStatus("idle")).toBe("waiting");
    expect(runtimeStatus("unknown")).toBe("unknown");
  });

  test("preserves a non-terminal source without inventing a location", () => {
    const agent = runtimeAgent({
      id: "api:session-1",
      source: { id: "api-openai", kind: "api", label: "OpenAI API" },
      name: "Research",
      kind: "assistant",
      provider: "OpenAI",
      model: "gpt-5",
      status: "working",
      focused: false,
      revision: 8,
      capabilities: {
        terminal: false,
        output: true,
        conversation: true,
        workspaceChanges: false,
        spawn: false,
        lineage: false,
      },
    });

    expect(agent.provider).toBe("OpenAI");
    expect(agent.model).toBe("gpt-5");
    expect(agent.workspace).toBeUndefined();
    expect(agent.task).toBe("Live OpenAI API agent");
    expect(agent.runtime).toMatchObject({
      sourceKind: "api",
      capabilities: { terminal: false, conversation: true, workspaceChanges: false },
    });
  });

  test("keeps runtime identity and marks completed turns for attention", () => {
    const agent = runtimeAgent({
      id: "w1:p2",
      source: { id: "herdr-local", kind: "herdr", label: "Herdr" },
      name: "Review",
      kind: "codex",
      status: "done",
      location: {
        workspaceId: "w1",
        workspaceLabel: "heed",
        tabId: "w1:t1",
        paneId: "w1:p2",
        cwd: "/repo/heed",
      },
      terminalTitle: "Review changes",
      focused: false,
      revision: 4,
      interactiveReady: true,
      capabilities: {
        terminal: true,
        output: true,
        conversation: false,
        workspaceChanges: true,
        spawn: false,
        lineage: false,
      },
    });

    expect(agent.provider).toBe("Herdr");

    expect(agent.status).toBe("done");
    expect(agent.attention).toBe("Turn complete");
    expect(agent.workspace).toBe("heed");
    expect(agent.runtime).toMatchObject({
      sourceLabel: "Herdr",
      location: { paneId: "w1:p2", cwd: "/repo/heed" },
      capabilities: { terminal: true, workspaceChanges: true },
    });
  });
});
