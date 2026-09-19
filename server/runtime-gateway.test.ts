import { describe, expect, test } from "vitest";
import type { RuntimeAgent, RuntimeCapabilities, RuntimeSource } from "../src/runtime/types";
import { MockApiRuntimeAdapter } from "./mock-runtime";
import { handleRuntimeRequest, RuntimeGateway, type RuntimeAdapter } from "./runtime-gateway";

const capabilities: RuntimeCapabilities = {
  terminal: false,
  output: true,
  conversation: false,
  workspaceChanges: false,
  spawn: false,
  lineage: false,
};

function agent(source: RuntimeSource, id: string): RuntimeAgent {
  return {
    id,
    source,
    name: id,
    kind: "assistant",
    status: "working",
    focused: false,
    revision: 1,
    capabilities,
  };
}

function adapter(source: RuntimeSource, snapshot: { readonly available: boolean; readonly agents: readonly RuntimeAgent[]; readonly error?: string }): RuntimeAdapter {
  return { source, snapshot: async () => ({ ...snapshot, fetchedAt: Date.now() }) };
}

describe("runtime gateway", () => {
  test("aggregates agents and sources without requiring a terminal", async () => {
    const herdr: RuntimeSource = { id: "herdr-local", kind: "herdr", label: "Herdr" };
    const api: RuntimeSource = { id: "api-test", kind: "api", label: "Test API" };
    const gateway = new RuntimeGateway([
      adapter(herdr, { available: true, agents: [agent(herdr, "herdr-local:one")] }),
      adapter(api, { available: true, agents: [agent(api, "api-test:one")] }),
    ]);

    const snapshot = await gateway.snapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.sources).toEqual([herdr, api]);
    expect(snapshot.agents.map(({ id }) => id)).toEqual(["herdr-local:one", "api-test:one"]);
  });

  test("keeps available sources when another source is offline", async () => {
    const live: RuntimeSource = { id: "live", kind: "api", label: "Live API" };
    const offline: RuntimeSource = { id: "offline", kind: "other", label: "Offline" };
    const gateway = new RuntimeGateway([
      adapter(live, { available: true, agents: [agent(live, "live:one")] }),
      adapter(offline, { available: false, agents: [], error: "Connection refused" }),
    ]);

    const snapshot = await gateway.snapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.sources).toEqual([live, offline]);
  });

  test("marks a viewed agent through the owning runtime", async () => {
    const source: RuntimeSource = { id: "herdr-local", kind: "herdr", label: "Herdr" };
    let viewedId: string | undefined;
    const gateway = new RuntimeGateway([{
      ...adapter(source, { available: true, agents: [agent(source, "herdr-local:done")] }),
      markViewed: async (id) => { viewedId = id; },
    }]);

    const response = await handleRuntimeRequest(
      new Request("http://127.0.0.1/api/runtime/agents/herdr-local%3Adone/view", { method: "POST" }),
      gateway,
    );

    expect(response?.status).toBe(200);
    expect(viewedId).toBe("herdr-local:done");
  });

  test("returns a capability error when a source has no terminal", async () => {
    const adapterInstance = new MockApiRuntimeAdapter();
    const gateway = new RuntimeGateway([adapterInstance]);
    const response = await handleRuntimeRequest(
      new Request("http://127.0.0.1/api/runtime/agents/mock-api%3Aresearch/terminal", { method: "POST", body: "{}" }),
      gateway,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({ error: "Mock API does not expose an interactive terminal." });
  });

  test("rejects duplicate source identities", () => {
    const source: RuntimeSource = { id: "duplicate", kind: "other", label: "Duplicate" };
    expect(() => new RuntimeGateway([adapter(source, { available: true, agents: [] }), adapter(source, { available: true, agents: [] })])).toThrow(
      "Duplicate runtime source: duplicate",
    );
  });
});
