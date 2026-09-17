import { describe, expect, test } from "vitest";
import { runtimeAgent, runtimeStatus } from "./map";

describe("Herdr runtime mapping", () => {
  test("maps blocked and idle states without inventing failure", () => {
    expect(runtimeStatus("blocked")).toBe("needs-you");
    expect(runtimeStatus("idle")).toBe("waiting");
    expect(runtimeStatus("unknown")).toBe("unknown");
  });

  test("keeps runtime identity and marks completed turns for attention", () => {
    const agent = runtimeAgent({
      id: "w1:p2",
      paneId: "w1:p2",
      name: "Review",
      kind: "codex",
      status: "done",
      workspaceId: "w1",
      workspaceLabel: "heed",
      tabId: "w1:t1",
      cwd: "/repo/heed",
      terminalTitle: "Review changes",
      focused: false,
      revision: 4,
      interactiveReady: true,
    });

    expect(agent.status).toBe("done");
    expect(agent.attention).toBe("Turn complete");
    expect(agent.workspace).toBe("heed");
    expect(agent.runtime).toMatchObject({ paneId: "w1:p2", cwd: "/repo/heed" });
  });
});
