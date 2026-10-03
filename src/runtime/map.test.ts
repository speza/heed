import { describe, expect, test } from "vitest";
import { displayPath, formatDuration, runtimeAgent, runtimeStatus } from "./map";

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
        reply: false,
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
        reply: true,
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

describe("runtime display helpers", () => {
  test("formats compact durations", () => {
    expect(formatDuration(4_000)).toBe("now");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(7 * 60_000)).toBe("7m");
    expect(formatDuration(3 * 3_600_000)).toBe("3h");
    expect(formatDuration(72 * 3_600_000)).toBe("3d");
  });

  test("abbreviates home directories only at the path root", () => {
    expect(displayPath("/Users/sam/Documents/heed")).toBe("~/Documents/heed");
    expect(displayPath("/home/sam")).toBe("~");
    expect(displayPath("/srv/Users/sam")).toBe("/srv/Users/sam");
  });

  test("shows time in state only when the gateway observed it", () => {
    const base = {
      id: "herdr-local:p1",
      source: { id: "herdr-local", kind: "herdr", label: "Herdr" },
      name: "Agent",
      kind: "claude",
      status: "blocked",
      focused: false,
      revision: 1,
      capabilities: { terminal: true, output: true, conversation: false, workspaceChanges: true, spawn: false, lineage: false, reply: true },
    } as const;

    expect(runtimeAgent(base).elapsed).toBeUndefined();
    expect(runtimeAgent({ ...base, statusSince: 1_000, stateSequence: 5 }, 181_000)).toMatchObject({
      elapsed: "3m",
      runtime: { stateSequence: 5, statusSince: 1_000 },
    });
  });
});
